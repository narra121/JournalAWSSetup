import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBDocumentClient, GetCommand } from '@aws-sdk/lib-dynamodb';

// Mock environment variables before importing module
vi.stubEnv('SUBSCRIPTIONS_TABLE', 'test-subscriptions');

const ddbMock = mockClient(DynamoDBDocumentClient);

import { checkSubscription, isExemptPath } from '../subscription';

// ─── Tests ───────────────────────────────────────────────────────

beforeEach(() => {
  ddbMock.reset();
});

describe('checkSubscription', () => {
  // ── 1. Returns null (allows access) when subscription status='active' ──

  it('returns null when subscription status is active', async () => {
    ddbMock.on(GetCommand).resolves({
      Item: {
        userId: 'user-1',
        status: 'active',
        createdAt: '2024-12-01T00:00:00.000Z',
      },
    });

    const result = await checkSubscription('user-1');
    expect(result).toBeNull();
  });

  // ── 2. Returns null when trial is active (trialEnd in future) ──

  it('returns null when trial is active (trialEnd in future)', async () => {
    const futureDate = new Date(Date.now() + 86400000 * 7).toISOString(); // 7 days from now
    ddbMock.on(GetCommand).resolves({
      Item: {
        userId: 'user-1',
        status: 'trial',
        trialEnd: futureDate,
      },
    });

    const result = await checkSubscription('user-1');
    expect(result).toBeNull();
  });

  // ── 3. Returns 403 when trial expired (trialEnd in past) ──

  it('returns 403 when trial expired (trialEnd in past)', async () => {
    const pastDate = new Date(Date.now() - 86400000).toISOString(); // 1 day ago
    ddbMock.on(GetCommand).resolves({
      Item: {
        userId: 'user-1',
        status: 'trial',
        trialEnd: pastDate,
      },
    });

    const result = await checkSubscription('user-1');
    expect(result).not.toBeNull();
    expect(result!.statusCode).toBe(403);
    const body = JSON.parse(result!.body as string);
    expect(body.errorCode).toBe('SUBSCRIPTION_REQUIRED');
    expect(body.errors).toBeDefined();
    expect(body.errors[0].reason).toBe('trial_expired');
  });

  // ── 4. Returns 403 with reason='subscription_cancelled' when status='cancelled' ──

  it('returns 403 with reason=subscription_cancelled when status is cancelled', async () => {
    ddbMock.on(GetCommand).resolves({
      Item: {
        userId: 'user-1',
        status: 'cancelled',
      },
    });

    const result = await checkSubscription('user-1');
    expect(result).not.toBeNull();
    expect(result!.statusCode).toBe(403);
    const body = JSON.parse(result!.body as string);
    expect(body.errorCode).toBe('SUBSCRIPTION_REQUIRED');
    expect(body.errors[0].reason).toBe('subscription_cancelled');
  });

  // ── 5. Returns 403 with reason='payment_failed' when status='past_due' ──

  it('returns 403 with reason=payment_failed when status is past_due', async () => {
    ddbMock.on(GetCommand).resolves({
      Item: {
        userId: 'user-1',
        status: 'past_due',
      },
    });

    const result = await checkSubscription('user-1');
    expect(result).not.toBeNull();
    expect(result!.statusCode).toBe(403);
    const body = JSON.parse(result!.body as string);
    expect(body.errorCode).toBe('SUBSCRIPTION_REQUIRED');
    expect(body.errors[0].reason).toBe('payment_failed');
  });

  // ── 6. Returns 403 with reason='no_subscription' when no record found ──

  it('returns 403 with reason=no_subscription when no record found', async () => {
    ddbMock.on(GetCommand).resolves({ Item: undefined });

    const result = await checkSubscription('user-1');
    expect(result).not.toBeNull();
    expect(result!.statusCode).toBe(403);
    const body = JSON.parse(result!.body as string);
    expect(body.errorCode).toBe('SUBSCRIPTION_REQUIRED');
    expect(body.errors[0].reason).toBe('no_subscription');
  });

  // ── 7. Returns null when status='cancellation_requested' but currentEnd is in future ──

  it('returns null when cancellation_requested but currentEnd is in future', async () => {
    const futureDate = new Date(Date.now() + 86400000 * 15).toISOString(); // 15 days from now
    ddbMock.on(GetCommand).resolves({
      Item: {
        userId: 'user-1',
        status: 'cancellation_requested',
        currentEnd: futureDate,
      },
    });

    const result = await checkSubscription('user-1');
    expect(result).toBeNull();
  });

  it('returns 403 when cancellation_requested and currentEnd is in past', async () => {
    const pastDate = new Date(Date.now() - 86400000).toISOString(); // 1 day ago
    ddbMock.on(GetCommand).resolves({
      Item: {
        userId: 'user-1',
        status: 'cancellation_requested',
        currentEnd: pastDate,
      },
    });

    const result = await checkSubscription('user-1');
    expect(result).not.toBeNull();
    expect(result!.statusCode).toBe(403);
    const body = JSON.parse(result!.body as string);
    expect(body.errorCode).toBe('SUBSCRIPTION_REQUIRED');
    expect(body.errors[0].reason).toBe('subscription_ended');
  });

  // ── 8. Returns null (fail open) when DynamoDB throws an error ──

  it('returns null (fail open) when DynamoDB throws an error', async () => {
    ddbMock.on(GetCommand).rejects(new Error('DynamoDB service unavailable'));

    const result = await checkSubscription('user-1');
    expect(result).toBeNull();
  });

  // ── Additional edge cases ──────────────────────────────────────

  it('returns 403 for paused subscription', async () => {
    ddbMock.on(GetCommand).resolves({
      Item: {
        userId: 'user-1',
        status: 'paused',
      },
    });

    const result = await checkSubscription('user-1');
    expect(result).not.toBeNull();
    expect(result!.statusCode).toBe(403);
    const body = JSON.parse(result!.body as string);
    expect(body.errors[0].reason).toBe('subscription_ended');
  });

  it('returns 403 for created (incomplete checkout) subscription', async () => {
    ddbMock.on(GetCommand).resolves({
      Item: {
        userId: 'user-1',
        status: 'created',
      },
    });

    const result = await checkSubscription('user-1');
    expect(result).not.toBeNull();
    expect(result!.statusCode).toBe(403);
    const body = JSON.parse(result!.body as string);
    expect(body.errors[0].reason).toBe('no_subscription');
  });

  it('response includes renewUrl in details', async () => {
    ddbMock.on(GetCommand).resolves({ Item: undefined });

    const result = await checkSubscription('user-1');
    expect(result).not.toBeNull();
    const body = JSON.parse(result!.body as string);
    expect(body.errors[0].renewUrl).toBe('/app/profile');
  });
});

describe('isExemptPath', () => {
  // ── 1. Returns true for /v1/user/profile ──

  it('returns true for /v1/user/profile', () => {
    expect(isExemptPath('/v1/user/profile')).toBe(true);
  });

  // ── 2. Returns true for /v1/subscriptions ──

  it('returns true for /v1/subscriptions', () => {
    expect(isExemptPath('/v1/subscriptions')).toBe(true);
  });

  // ── 3. Returns true for /v1/payments/webhook ──

  it('returns true for /v1/payments/webhook', () => {
    expect(isExemptPath('/v1/payments/webhook')).toBe(true);
  });

  // ── 4. Returns true for /v1/auth/login ──

  it('returns true for /v1/auth/login', () => {
    expect(isExemptPath('/v1/auth/login')).toBe(true);
  });

  // ── 5. Returns false for /v1/trades ──

  it('returns false for /v1/trades', () => {
    expect(isExemptPath('/v1/trades')).toBe(false);
  });

  // ── 6. Returns false for /v1/analytics ──

  it('returns false for /v1/analytics', () => {
    expect(isExemptPath('/v1/analytics')).toBe(false);
  });

  // ── Additional exempt paths ──

  it('returns true for /v1/user/preferences', () => {
    expect(isExemptPath('/v1/user/preferences')).toBe(true);
  });

  it('returns true for /v1/user/notifications', () => {
    expect(isExemptPath('/v1/user/notifications')).toBe(true);
  });

  it('returns true for /v1/auth/signup (prefix match)', () => {
    expect(isExemptPath('/v1/auth/signup')).toBe(true);
  });

  it('returns true for /v1/subscriptions/plans (prefix match)', () => {
    expect(isExemptPath('/v1/subscriptions/plans')).toBe(true);
  });

  // ── Non-exempt paths ──

  it('returns false for /v1/accounts', () => {
    expect(isExemptPath('/v1/accounts')).toBe(false);
  });

  it('returns false for /v1/rules', () => {
    expect(isExemptPath('/v1/rules')).toBe(false);
  });

  it('returns false for /v1/goals', () => {
    expect(isExemptPath('/v1/goals')).toBe(false);
  });
});
