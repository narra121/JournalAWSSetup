import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBDocumentClient, PutCommand } from '@aws-sdk/lib-dynamodb';
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

function makeEvent(body: any, overrides: Partial<APIGatewayProxyEventV2> = {}): APIGatewayProxyEventV2 {
  return {
    version: '2.0',
    routeKey: 'POST /subscriptions',
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
      http: { method: 'POST', path: '/subscriptions', protocol: 'HTTP/1.1', sourceIp: '127.0.0.1', userAgent: 'test' },
      requestId: 'req-1',
      routeKey: 'POST /subscriptions',
      stage: '$default',
      time: '01/Jan/2024:00:00:00 +0000',
      timeEpoch: 0,
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
    isBase64Encoded: false,
    ...overrides,
  } as unknown as APIGatewayProxyEventV2;
}

// ─── Tests ──────────────────────────────────────────────────────

beforeEach(() => {
  ddbMock.reset();
  ddbMock.on(PutCommand).resolves({});
});

describe('create-subscription handler', () => {
  // ── Success ─────────────────────────────────────────────────

  it('creates a subscription and returns 201', async () => {
    const res = await handler(makeEvent({ amount: 50, billingCycle: 'monthly' }), {} as any, () => {}) as any;

    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(true);
    expect(body.data.subscription).toBeDefined();
    expect(body.data.subscription.status).toBe('active');
    expect(body.data.subscription.userId).toBe('user-1');
    expect(body.data.paymentUrl).toBeDefined();
  });

  // ── Plan determination ──────────────────────────────────────

  it('determines plan as "champion" when amount >= 60', async () => {
    const res = await handler(makeEvent({ amount: 60, billingCycle: 'monthly' }), {} as any, () => {}) as any;

    const body = JSON.parse(res.body);
    expect(body.data.subscription.plan).toBe('champion');
  });

  it('determines plan as "champion" when amount > 60', async () => {
    const res = await handler(makeEvent({ amount: 100, billingCycle: 'monthly' }), {} as any, () => {}) as any;

    const body = JSON.parse(res.body);
    expect(body.data.subscription.plan).toBe('champion');
  });

  it('determines plan as "supporter" when amount >= 36 and < 60', async () => {
    const res = await handler(makeEvent({ amount: 36, billingCycle: 'monthly' }), {} as any, () => {}) as any;

    const body = JSON.parse(res.body);
    expect(body.data.subscription.plan).toBe('supporter');
  });

  it('determines plan as "supporter" when amount is 50', async () => {
    const res = await handler(makeEvent({ amount: 50, billingCycle: 'monthly' }), {} as any, () => {}) as any;

    const body = JSON.parse(res.body);
    expect(body.data.subscription.plan).toBe('supporter');
  });

  it('determines plan as "basic" when amount < 36', async () => {
    const res = await handler(makeEvent({ amount: 10, billingCycle: 'monthly' }), {} as any, () => {}) as any;

    const body = JSON.parse(res.body);
    expect(body.data.subscription.plan).toBe('basic');
  });

  // ── Billing dates ───────────────────────────────────────────

  it('sets nextBillingDate one month ahead for monthly billing', async () => {
    const res = await handler(makeEvent({ amount: 10, billingCycle: 'monthly' }), {} as any, () => {}) as any;

    const body = JSON.parse(res.body);
    const created = new Date(body.data.subscription.createdAt);
    const nextBilling = new Date(body.data.subscription.nextBillingDate);

    // Next billing should be approximately 1 month ahead
    const expectedMonth = (created.getMonth() + 1) % 12;
    expect(nextBilling.getMonth()).toBe(expectedMonth);
  });

  it('sets nextBillingDate one year ahead for annual billing', async () => {
    const res = await handler(makeEvent({ amount: 10, billingCycle: 'annual' }), {} as any, () => {}) as any;

    const body = JSON.parse(res.body);
    const created = new Date(body.data.subscription.createdAt);
    const nextBilling = new Date(body.data.subscription.nextBillingDate);

    // Next billing should be exactly 1 year ahead
    expect(nextBilling.getFullYear()).toBe(created.getFullYear() + 1);
  });

  // ── Auth errors ─────────────────────────────────────────────

  it('returns 401 when authorization header is missing', async () => {
    const event = makeEvent({ amount: 50, billingCycle: 'monthly' });
    event.headers = {};
    const res = await handler(event, {} as any, () => {}) as any;

    expect(res.statusCode).toBe(401);
    const body = JSON.parse(res.body);
    expect(body.errorCode).toBe('UNAUTHORIZED');
  });

  // ── Validation errors ───────────────────────────────────────

  it('returns 400 when body is missing', async () => {
    const event = makeEvent(undefined);
    event.body = undefined;
    const res = await handler(event, {} as any, () => {}) as any;

    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.errorCode).toBe('VALIDATION_ERROR');
  });

  it('returns 400 when body is invalid JSON', async () => {
    const event = makeEvent({ amount: 50, billingCycle: 'monthly' });
    event.body = '{not-valid-json';
    const res = await handler(event, {} as any, () => {}) as any;

    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.errorCode).toBe('VALIDATION_ERROR');
    expect(body.message).toContain('Invalid JSON');
  });

  it('returns 400 when amount is missing', async () => {
    const res = await handler(makeEvent({ billingCycle: 'monthly' }), {} as any, () => {}) as any;

    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.errorCode).toBe('VALIDATION_ERROR');
  });

  it('returns 400 when billingCycle is missing', async () => {
    const res = await handler(makeEvent({ amount: 50 }), {} as any, () => {}) as any;

    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.errorCode).toBe('VALIDATION_ERROR');
  });

  // ── DynamoDB errors ─────────────────────────────────────────

  it('returns 500 when DynamoDB write fails', async () => {
    ddbMock.on(PutCommand).rejects(new Error('DynamoDB write error'));

    const res = await handler(makeEvent({ amount: 50, billingCycle: 'monthly' }), {} as any, () => {}) as any;

    expect(res.statusCode).toBe(500);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(false);
    expect(body.errorCode).toBe('INTERNAL_ERROR');
  });
});
