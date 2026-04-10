import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBDocumentClient, GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import type { APIGatewayProxyEventV2 } from 'aws-lambda';

// Mock environment variables before importing handler
vi.stubEnv('SUBSCRIPTIONS_TABLE', 'test-subscriptions');

const ddbMock = mockClient(DynamoDBDocumentClient);

const { handler } = await import('../app.ts');

// ─── Helpers ────────────────────────────────────────────────────

function makeJwt(sub: string): string {
  const header = btoa(JSON.stringify({ alg: 'RS256' }));
  const payload = btoa(JSON.stringify({ sub }));
  return `${header}.${payload}.sig`;
}

function makeEvent(overrides: Partial<APIGatewayProxyEventV2> = {}): APIGatewayProxyEventV2 {
  return {
    version: '2.0',
    routeKey: 'POST /subscriptions/cancel',
    rawPath: '/subscriptions/cancel',
    rawQueryString: '',
    headers: {
      authorization: `Bearer ${makeJwt('user-1')}`,
      ...((overrides as any).headers || {}),
    },
    requestContext: {
      accountId: '123',
      apiId: 'api',
      domainName: 'api.example.com',
      domainPrefix: 'api',
      http: { method: 'POST', path: '/subscriptions/cancel', protocol: 'HTTP/1.1', sourceIp: '127.0.0.1', userAgent: 'test' },
      requestId: 'req-1',
      routeKey: 'POST /subscriptions/cancel',
      stage: '$default',
      time: '01/Jan/2024:00:00:00 +0000',
      timeEpoch: 0,
    },
    isBase64Encoded: false,
    ...overrides,
  } as unknown as APIGatewayProxyEventV2;
}

const existingSubscription = {
  userId: 'user-1',
  status: 'active',
  plan: 'supporter',
  amount: 50,
  billingCycle: 'monthly',
  nextBillingDate: '2025-01-15T00:00:00.000Z',
  createdAt: '2024-12-15T00:00:00.000Z',
  updatedAt: '2024-12-15T00:00:00.000Z',
};

// ─── Tests ──────────────────────────────────────────────────────

beforeEach(() => {
  ddbMock.reset();
});

describe('cancel-subscription handler', () => {
  // ── Success ─────────────────────────────────────────────────

  it('cancels a subscription and returns 200 with cancelled status', async () => {
    ddbMock.on(GetCommand).resolves({ Item: existingSubscription });
    ddbMock.on(UpdateCommand).resolves({
      Attributes: { ...existingSubscription, status: 'cancelled', updatedAt: '2024-12-16T00:00:00.000Z' },
    });

    const res = await handler(makeEvent(), {} as any, () => {}) as any;

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(true);
    expect(body.data.subscription).toBeDefined();
    expect(body.data.subscription.status).toBe('cancelled');
  });

  // ── Auth errors ─────────────────────────────────────────────

  it('returns 401 when authorization header is missing', async () => {
    const event = makeEvent({ headers: {} });
    const res = await handler(event, {} as any, () => {}) as any;

    expect(res.statusCode).toBe(401);
    const body = JSON.parse(res.body);
    expect(body.errorCode).toBe('UNAUTHORIZED');
  });

  // ── Not found ───────────────────────────────────────────────

  it('returns 404 when subscription does not exist', async () => {
    ddbMock.on(GetCommand).resolves({ Item: undefined });

    const res = await handler(makeEvent(), {} as any, () => {}) as any;

    expect(res.statusCode).toBe(404);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(false);
    expect(body.errorCode).toBe('TRADE_NOT_FOUND');
  });

  // ── DynamoDB errors ─────────────────────────────────────────

  it('returns 500 when DynamoDB GetCommand fails', async () => {
    ddbMock.on(GetCommand).rejects(new Error('DynamoDB error'));

    const res = await handler(makeEvent(), {} as any, () => {}) as any;

    expect(res.statusCode).toBe(500);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(false);
    expect(body.errorCode).toBe('INTERNAL_ERROR');
  });

  it('returns 500 when DynamoDB UpdateCommand fails', async () => {
    ddbMock.on(GetCommand).resolves({ Item: existingSubscription });
    ddbMock.on(UpdateCommand).rejects(new Error('DynamoDB update error'));

    const res = await handler(makeEvent(), {} as any, () => {}) as any;

    expect(res.statusCode).toBe(500);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(false);
    expect(body.errorCode).toBe('INTERNAL_ERROR');
  });

  // ── Already cancelled ──────────────────────────────────────

  it('cancels an already-cancelled subscription (handler does not guard against re-cancel)', async () => {
    const cancelledSub = { ...existingSubscription, status: 'cancelled' };
    ddbMock.on(GetCommand).resolves({ Item: cancelledSub });
    ddbMock.on(UpdateCommand).resolves({
      Attributes: { ...cancelledSub, updatedAt: '2024-12-17T00:00:00.000Z' },
    });

    const res = await handler(makeEvent(), {} as any, () => {}) as any;

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(true);
    expect(body.data.subscription.status).toBe('cancelled');
  });

  // ── Auth edge cases ────────────────────────────────────────

  it('returns 401 when token is malformed (no sub claim)', async () => {
    const badHeader = btoa(JSON.stringify({ alg: 'RS256' }));
    const badPayload = btoa(JSON.stringify({ iss: 'bad' }));
    const event = makeEvent({ headers: { authorization: `Bearer ${badHeader}.${badPayload}.sig` } });
    const res = await handler(event, {} as any, () => {}) as any;

    expect(res.statusCode).toBe(401);
    const body = JSON.parse(res.body);
    expect(body.errorCode).toBe('UNAUTHORIZED');
  });

  it('returns 401 when authorization header has empty Bearer token', async () => {
    const event = makeEvent({ headers: { authorization: 'Bearer ' } });
    const res = await handler(event, {} as any, () => {}) as any;

    expect(res.statusCode).toBe(401);
    const body = JSON.parse(res.body);
    expect(body.errorCode).toBe('UNAUTHORIZED');
  });

  // ── Response shape ─────────────────────────────────────────

  it('response body contains message "Subscription cancelled"', async () => {
    ddbMock.on(GetCommand).resolves({ Item: existingSubscription });
    ddbMock.on(UpdateCommand).resolves({
      Attributes: { ...existingSubscription, status: 'cancelled', updatedAt: '2024-12-16T00:00:00.000Z' },
    });

    const res = await handler(makeEvent(), {} as any, () => {}) as any;

    const body = JSON.parse(res.body);
    expect(body.message).toBe('Subscription cancelled');
  });

  it('returns 404 with correct error code when subscription is missing', async () => {
    ddbMock.on(GetCommand).resolves({ Item: undefined });

    const res = await handler(makeEvent(), {} as any, () => {}) as any;

    expect(res.statusCode).toBe(404);
    const body = JSON.parse(res.body);
    expect(body.message).toBe('Subscription not found');
  });

  // ── DynamoDB conditional failures ──────────────────────────

  it('returns 500 when DynamoDB GetCommand returns network error', async () => {
    const networkError = new Error('Network error');
    (networkError as any).name = 'TimeoutError';
    ddbMock.on(GetCommand).rejects(networkError);

    const res = await handler(makeEvent(), {} as any, () => {}) as any;

    expect(res.statusCode).toBe(500);
    const body = JSON.parse(res.body);
    expect(body.errorCode).toBe('INTERNAL_ERROR');
    expect(body.message).toBe('Failed to cancel subscription');
  });

  it('returns subscription with updatedAt timestamp after cancellation', async () => {
    ddbMock.on(GetCommand).resolves({ Item: existingSubscription });
    ddbMock.on(UpdateCommand).resolves({
      Attributes: { ...existingSubscription, status: 'cancelled', updatedAt: '2024-12-20T10:30:00.000Z' },
    });

    const res = await handler(makeEvent(), {} as any, () => {}) as any;

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.data.subscription.updatedAt).toBe('2024-12-20T10:30:00.000Z');
    expect(body.data.subscription.updatedAt).not.toBe(existingSubscription.updatedAt);
  });
});
