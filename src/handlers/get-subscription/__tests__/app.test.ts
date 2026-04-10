import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBDocumentClient, GetCommand } from '@aws-sdk/lib-dynamodb';
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
    routeKey: 'GET /subscriptions',
    rawPath: '/subscriptions',
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
      http: { method: 'GET', path: '/subscriptions', protocol: 'HTTP/1.1', sourceIp: '127.0.0.1', userAgent: 'test' },
      requestId: 'req-1',
      routeKey: 'GET /subscriptions',
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

describe('get-subscription handler', () => {
  // ── Success ─────────────────────────────────────────────────

  it('returns 200 with subscription when found', async () => {
    ddbMock.on(GetCommand).resolves({ Item: existingSubscription });

    const res = await handler(makeEvent(), {} as any, () => {}) as any;

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(true);
    expect(body.data.subscription).toBeDefined();
    expect(body.data.subscription.userId).toBe('user-1');
    expect(body.data.subscription.status).toBe('active');
    expect(body.data.subscription.plan).toBe('supporter');
  });

  // ── Not found ───────────────────────────────────────────────

  it('returns 404 with null subscription when not found', async () => {
    ddbMock.on(GetCommand).resolves({ Item: undefined });

    const res = await handler(makeEvent(), {} as any, () => {}) as any;

    expect(res.statusCode).toBe(404);
    const body = JSON.parse(res.body);
    // Uses envelope (not errorResponse), so success is false but data is present
    expect(body.success).toBe(false);
    expect(body.data).toBeDefined();
    expect(body.data.subscription).toBeNull();
    expect(body.message).toBe('No subscription found');
  });

  // ── Auth errors ─────────────────────────────────────────────

  it('returns 401 when authorization header is missing', async () => {
    const event = makeEvent({ headers: {} });
    const res = await handler(event, {} as any, () => {}) as any;

    expect(res.statusCode).toBe(401);
    const body = JSON.parse(res.body);
    expect(body.errorCode).toBe('UNAUTHORIZED');
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

  it('returns 500 with correct message when DynamoDB times out', async () => {
    const timeoutError = new Error('Request timed out');
    (timeoutError as any).name = 'TimeoutError';
    ddbMock.on(GetCommand).rejects(timeoutError);

    const res = await handler(makeEvent(), {} as any, () => {}) as any;

    expect(res.statusCode).toBe(500);
    const body = JSON.parse(res.body);
    expect(body.message).toBe('Failed to retrieve subscription');
  });

  // ── Subscription status variations ─────────────────────────

  it('returns subscription with cancelled status', async () => {
    const cancelledSub = { ...existingSubscription, status: 'cancelled' };
    ddbMock.on(GetCommand).resolves({ Item: cancelledSub });

    const res = await handler(makeEvent(), {} as any, () => {}) as any;

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.data.subscription.status).toBe('cancelled');
  });

  it('returns subscription with expired status', async () => {
    const expiredSub = {
      ...existingSubscription,
      status: 'expired',
      nextBillingDate: '2024-01-01T00:00:00.000Z',
    };
    ddbMock.on(GetCommand).resolves({ Item: expiredSub });

    const res = await handler(makeEvent(), {} as any, () => {}) as any;

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.data.subscription.status).toBe('expired');
    expect(body.data.subscription.nextBillingDate).toBe('2024-01-01T00:00:00.000Z');
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

  // ── Subscription with all fields ──────────────────────────

  it('returns subscription with all optional fields populated', async () => {
    const fullSub = {
      ...existingSubscription,
      razorpaySubscriptionId: 'sub_abc123',
      razorpayPaymentId: 'pay_xyz789',
      planId: 'plan_premium',
      startDate: '2024-12-15T00:00:00.000Z',
      endDate: '2025-12-15T00:00:00.000Z',
    };
    ddbMock.on(GetCommand).resolves({ Item: fullSub });

    const res = await handler(makeEvent(), {} as any, () => {}) as any;

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.data.subscription.razorpaySubscriptionId).toBe('sub_abc123');
    expect(body.data.subscription.razorpayPaymentId).toBe('pay_xyz789');
    expect(body.data.subscription.planId).toBe('plan_premium');
    expect(body.data.subscription.startDate).toBe('2024-12-15T00:00:00.000Z');
    expect(body.data.subscription.endDate).toBe('2025-12-15T00:00:00.000Z');
  });

  it('returns subscription with minimal fields (only userId and status)', async () => {
    const minimalSub = { userId: 'user-1', status: 'active' };
    ddbMock.on(GetCommand).resolves({ Item: minimalSub });

    const res = await handler(makeEvent(), {} as any, () => {}) as any;

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.data.subscription.userId).toBe('user-1');
    expect(body.data.subscription.status).toBe('active');
    expect(body.data.subscription.plan).toBeUndefined();
  });

  // ── Response shape ─────────────────────────────────────────

  it('response envelope message is "Subscription retrieved" on success', async () => {
    ddbMock.on(GetCommand).resolves({ Item: existingSubscription });

    const res = await handler(makeEvent(), {} as any, () => {}) as any;

    const body = JSON.parse(res.body);
    expect(body.message).toBe('Subscription retrieved');
  });
});
