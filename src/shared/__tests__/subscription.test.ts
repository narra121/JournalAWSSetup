import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBDocumentClient, GetCommand } from '@aws-sdk/lib-dynamodb';

// Mock environment variables before importing module
vi.stubEnv('SUBSCRIPTIONS_TABLE', 'test-subscriptions');

const ddbMock = mockClient(DynamoDBDocumentClient);

import { checkSubscription, isExemptPath, getSubscriptionTier } from '../subscription';

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

  // ── 3. Returns null when trial expired (free tier with ads) ──

  it('returns null when trial expired (trialEnd in past)', async () => {
    const pastDate = new Date(Date.now() - 86400000).toISOString(); // 1 day ago
    ddbMock.on(GetCommand).resolves({
      Item: {
        userId: 'user-1',
        status: 'trial',
        trialEnd: pastDate,
      },
    });

    const result = await checkSubscription('user-1');
    expect(result).toBeNull();
  });

  // ── 4. Returns null when status='cancelled' (free tier with ads) ──

  it('returns null when status is cancelled', async () => {
    ddbMock.on(GetCommand).resolves({
      Item: {
        userId: 'user-1',
        status: 'cancelled',
      },
    });

    const result = await checkSubscription('user-1');
    expect(result).toBeNull();
  });

  // ── 5. Returns null when status='past_due' (free tier with ads) ──

  it('returns null when status is past_due', async () => {
    ddbMock.on(GetCommand).resolves({
      Item: {
        userId: 'user-1',
        status: 'past_due',
      },
    });

    const result = await checkSubscription('user-1');
    expect(result).toBeNull();
  });

  // ── 6. Returns null when no record found (free tier with ads) ──

  it('returns null when no record found', async () => {
    ddbMock.on(GetCommand).resolves({ Item: undefined });

    const result = await checkSubscription('user-1');
    expect(result).toBeNull();
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

  it('returns null when cancellation_requested and currentEnd is in past', async () => {
    const pastDate = new Date(Date.now() - 86400000).toISOString(); // 1 day ago
    ddbMock.on(GetCommand).resolves({
      Item: {
        userId: 'user-1',
        status: 'cancellation_requested',
        currentEnd: pastDate,
      },
    });

    const result = await checkSubscription('user-1');
    expect(result).toBeNull();
  });

  // ── 8. Returns 503 (fail closed) when DynamoDB throws an error ──

  it('returns 503 (fail closed) when DynamoDB throws an error', async () => {
    ddbMock.on(GetCommand).rejects(new Error('DynamoDB service unavailable'));

    const result = await checkSubscription('user-1');
    expect(result).not.toBeNull();
    expect(result!.statusCode).toBe(503);
    const body = JSON.parse(result!.body as string);
    expect(body.success).toBe(false);
    expect(body.message).toBe('Service temporarily unavailable');
  });

  // ── Additional edge cases ──────────────────────────────────────

  it('returns null for paused subscription', async () => {
    ddbMock.on(GetCommand).resolves({
      Item: {
        userId: 'user-1',
        status: 'paused',
      },
    });

    const result = await checkSubscription('user-1');
    expect(result).toBeNull();
  });

  it('returns null for created (incomplete checkout) subscription', async () => {
    ddbMock.on(GetCommand).resolves({
      Item: {
        userId: 'user-1',
        status: 'created',
      },
    });

    const result = await checkSubscription('user-1');
    expect(result).toBeNull();
  });

  it('returns null for completed subscription', async () => {
    ddbMock.on(GetCommand).resolves({
      Item: {
        userId: 'user-1',
        status: 'completed',
      },
    });

    const result = await checkSubscription('user-1');
    expect(result).toBeNull();
  });
});

// ─── getSubscriptionTier ─────────────────────────────────────────

describe('getSubscriptionTier', () => {
  it('returns paid tier for active subscription', async () => {
    ddbMock.on(GetCommand).resolves({
      Item: { userId: 'user-1', status: 'active' },
    });

    const result = await getSubscriptionTier('user-1');
    expect(result.tier).toBe('paid');
    expect(result.showAds).toBe(false);
    expect(result.status).toBe('active');
  });

  it('returns trial tier for active trial', async () => {
    const futureDate = new Date(Date.now() + 86400000 * 7).toISOString();
    ddbMock.on(GetCommand).resolves({
      Item: { userId: 'user-1', status: 'trial', trialEnd: futureDate },
    });

    const result = await getSubscriptionTier('user-1');
    expect(result.tier).toBe('trial');
    expect(result.showAds).toBe(false);
    expect(result.trialEnd).toBe(futureDate);
    expect(result.status).toBe('trial');
  });

  it('returns free_with_ads for expired trial', async () => {
    const pastDate = new Date(Date.now() - 86400000).toISOString();
    ddbMock.on(GetCommand).resolves({
      Item: { userId: 'user-1', status: 'trial', trialEnd: pastDate },
    });

    const result = await getSubscriptionTier('user-1');
    expect(result.tier).toBe('free_with_ads');
    expect(result.showAds).toBe(true);
    expect(result.trialEnd).toBe(pastDate);
    expect(result.status).toBe('trial');
  });

  it('returns free_with_ads for cancelled subscription', async () => {
    ddbMock.on(GetCommand).resolves({
      Item: { userId: 'user-1', status: 'cancelled' },
    });

    const result = await getSubscriptionTier('user-1');
    expect(result.tier).toBe('free_with_ads');
    expect(result.showAds).toBe(true);
    expect(result.status).toBe('cancelled');
  });

  it('returns free_with_ads when no record found', async () => {
    ddbMock.on(GetCommand).resolves({ Item: undefined });

    const result = await getSubscriptionTier('user-1');
    expect(result.tier).toBe('free_with_ads');
    expect(result.showAds).toBe(true);
    expect(result.status).toBe('none');
  });

  it('returns paid for cancellation_requested within period', async () => {
    const futureDate = new Date(Date.now() + 86400000 * 15).toISOString();
    ddbMock.on(GetCommand).resolves({
      Item: { userId: 'user-1', status: 'cancellation_requested', currentEnd: futureDate },
    });

    const result = await getSubscriptionTier('user-1');
    expect(result.tier).toBe('paid');
    expect(result.showAds).toBe(false);
    expect(result.status).toBe('cancellation_requested');
  });

  it('returns free_with_ads for cancellation_requested past period', async () => {
    const pastDate = new Date(Date.now() - 86400000).toISOString();
    ddbMock.on(GetCommand).resolves({
      Item: { userId: 'user-1', status: 'cancellation_requested', currentEnd: pastDate },
    });

    const result = await getSubscriptionTier('user-1');
    expect(result.tier).toBe('free_with_ads');
    expect(result.showAds).toBe(true);
    expect(result.status).toBe('cancellation_requested');
  });

  it('returns free_with_ads for past_due subscription', async () => {
    ddbMock.on(GetCommand).resolves({
      Item: { userId: 'user-1', status: 'past_due' },
    });

    const result = await getSubscriptionTier('user-1');
    expect(result.tier).toBe('free_with_ads');
    expect(result.showAds).toBe(true);
    expect(result.status).toBe('past_due');
  });

  it('returns free_with_ads for paused subscription', async () => {
    ddbMock.on(GetCommand).resolves({
      Item: { userId: 'user-1', status: 'paused' },
    });

    const result = await getSubscriptionTier('user-1');
    expect(result.tier).toBe('free_with_ads');
    expect(result.showAds).toBe(true);
    expect(result.status).toBe('paused');
  });

  it('returns free_with_ads for completed subscription', async () => {
    ddbMock.on(GetCommand).resolves({
      Item: { userId: 'user-1', status: 'completed' },
    });

    const result = await getSubscriptionTier('user-1');
    expect(result.tier).toBe('free_with_ads');
    expect(result.showAds).toBe(true);
    expect(result.status).toBe('completed');
  });

  it('returns free_with_ads for created subscription', async () => {
    ddbMock.on(GetCommand).resolves({
      Item: { userId: 'user-1', status: 'created' },
    });

    const result = await getSubscriptionTier('user-1');
    expect(result.tier).toBe('free_with_ads');
    expect(result.showAds).toBe(true);
    expect(result.status).toBe('created');
  });

  it('returns free_with_ads with status error on DynamoDB failure', async () => {
    ddbMock.on(GetCommand).rejects(new Error('DynamoDB service unavailable'));

    const result = await getSubscriptionTier('user-1');
    expect(result.tier).toBe('free_with_ads');
    expect(result.showAds).toBe(true);
    expect(result.status).toBe('error');
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

  it('returns true for /v1/ad-config', () => {
    expect(isExemptPath('/v1/ad-config')).toBe(true);
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
