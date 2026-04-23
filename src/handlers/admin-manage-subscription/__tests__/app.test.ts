import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBDocumentClient, PutCommand, GetCommand } from '@aws-sdk/lib-dynamodb';
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';
import type { APIGatewayProxyEventV2 } from 'aws-lambda';

// ─── Env ───────────────────────────────────────────────────────
vi.stubEnv('SUBSCRIPTIONS_TABLE', 'test-subscriptions');
vi.stubEnv('STRIPE_SECRET_KEY_PARAM', '/tradequt/dev/stripeSecretKey');

// ─── Stripe mock ─────────────────────────────────────────────
vi.mock('stripe', () => ({
  default: vi.fn().mockImplementation(() => ({
    refunds: { create: vi.fn().mockResolvedValue({ id: 're_123' }) },
    invoices: { list: vi.fn().mockResolvedValue({ data: [{ id: 'inv_123' }] }) },
  })),
}));

// ─── AWS mocks ───────────────────────────────────────────────
const ddbMock = mockClient(DynamoDBDocumentClient);
const ssmMock = mockClient(SSMClient);

// ─── Helpers ─────────────────────────────────────────────────
function makeEvent(userId: string | undefined, body?: any): APIGatewayProxyEventV2 {
  return {
    version: '2.0',
    routeKey: 'PUT /v1/admin/users/{userId}/subscription',
    rawPath: `/v1/admin/users/${userId}/subscription`,
    rawQueryString: '',
    headers: {},
    pathParameters: userId ? { userId } : undefined,
    requestContext: {
      accountId: '123',
      apiId: 'api',
      domainName: 'api.example.com',
      domainPrefix: 'api',
      http: { method: 'PUT', path: `/v1/admin/users/${userId}/subscription`, protocol: 'HTTP/1.1', sourceIp: '127.0.0.1', userAgent: 'test' },
      requestId: 'req-1',
      routeKey: 'PUT /v1/admin/users/{userId}/subscription',
      stage: '$default',
      time: '01/Jan/2024:00:00:00 +0000',
      timeEpoch: 0,
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
    isBase64Encoded: false,
  } as unknown as APIGatewayProxyEventV2;
}

async function freshHandler() {
  vi.resetModules();
  vi.doMock('stripe', () => ({
    default: vi.fn().mockImplementation(() => ({
      refunds: { create: vi.fn().mockResolvedValue({ id: 're_123' }) },
      invoices: { list: vi.fn().mockResolvedValue({ data: [{ id: 'inv_123' }] }) },
    })),
  }));
  const mod = await import('../app');
  return mod.handler;
}

function setupSsm() {
  ssmMock.on(GetParameterCommand, { Name: '/tradequt/dev/stripeSecretKey' }).resolves({
    Parameter: { Value: 'sk_test_123' },
  });
}

beforeEach(() => {
  ddbMock.reset();
  ssmMock.reset();
});

// ─── Tests ───────────────────────────────────────────────────
describe('admin-manage-subscription handler', () => {
  it('returns 400 if userId is missing', async () => {
    const handler = await freshHandler();
    const res = await handler(makeEvent(undefined, { action: 'cancel' }), {} as any, () => {}) as any;
    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(false);
    expect(body.errorCode).toBe('VALIDATION_ERROR');
    expect(body.message).toContain('userId');
  });

  it('returns 400 if body is missing', async () => {
    const handler = await freshHandler();
    const res = await handler(makeEvent('user-1'), {} as any, () => {}) as any;
    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(false);
    expect(body.errorCode).toBe('VALIDATION_ERROR');
  });

  it('returns 400 for invalid action', async () => {
    const handler = await freshHandler();
    const res = await handler(makeEvent('user-1', { action: 'invalid_action' }), {} as any, () => {}) as any;
    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(false);
    expect(body.errorCode).toBe('VALIDATION_ERROR');
    expect(body.message).toContain('Invalid action');
  });

  describe('grant_free', () => {
    it('grants 30-day subscription by default', async () => {
      const handler = await freshHandler();
      ddbMock.on(PutCommand).resolves({});

      const res = await handler(makeEvent('user-1', { action: 'grant_free' }), {} as any, () => {}) as any;
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(true);
      expect(body.data.userId).toBe('user-1');
      expect(body.data.status).toBe('active');
      expect(body.data.periodEnd).toBeDefined();

      const putCalls = ddbMock.commandCalls(PutCommand);
      expect(putCalls).toHaveLength(1);
      const item = putCalls[0].args[0].input.Item;
      expect(item?.userId).toBe('user-1');
      expect(item?.status).toBe('active');
      expect(item?.tier).toBe('active');
      expect(item?.source).toBe('admin_grant');
    });

    it('grants lifetime subscription when unit is lifetime', async () => {
      const handler = await freshHandler();
      ddbMock.on(PutCommand).resolves({});

      const res = await handler(makeEvent('user-1', { action: 'grant_free', unit: 'lifetime' }), {} as any, () => {}) as any;
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.data.periodEnd).toBe('9999-12-31T23:59:59.000Z');

      const putCalls = ddbMock.commandCalls(PutCommand);
      const item = putCalls[0].args[0].input.Item;
      expect(item?.periodEnd).toBe('9999-12-31T23:59:59.000Z');
    });
  });

  describe('cancel', () => {
    it('cancels subscription', async () => {
      const handler = await freshHandler();
      ddbMock.on(PutCommand).resolves({});

      const res = await handler(makeEvent('user-1', { action: 'cancel' }), {} as any, () => {}) as any;
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(true);
      expect(body.data.status).toBe('cancelled');

      const putCalls = ddbMock.commandCalls(PutCommand);
      expect(putCalls).toHaveLength(1);
      const item = putCalls[0].args[0].input.Item;
      expect(item?.userId).toBe('user-1');
      expect(item?.status).toBe('cancelled');
      expect(item?.source).toBe('admin_cancel');
    });
  });

  describe('refund', () => {
    it('returns 400 if no stripeCustomerId on subscription', async () => {
      const handler = await freshHandler();
      ddbMock.on(GetCommand).resolves({ Item: { userId: 'user-1' } });

      const res = await handler(makeEvent('user-1', { action: 'refund' }), {} as any, () => {}) as any;
      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(false);
      expect(body.message).toContain('No Stripe customer');
    });

    it('refunds and cancels subscription when stripeCustomerId exists', async () => {
      const handler = await freshHandler();
      setupSsm();
      ddbMock.on(GetCommand).resolves({
        Item: { userId: 'user-1', stripeCustomerId: 'cus_123' },
      });
      ddbMock.on(PutCommand).resolves({});

      const res = await handler(makeEvent('user-1', { action: 'refund' }), {} as any, () => {}) as any;
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(true);
      expect(body.data.status).toBe('cancelled');
      expect(body.data.refundId).toBe('re_123');

      const putCalls = ddbMock.commandCalls(PutCommand);
      expect(putCalls).toHaveLength(1);
      const item = putCalls[0].args[0].input.Item;
      expect(item?.status).toBe('cancelled');
      expect(item?.source).toBe('admin_refund');
      expect(item?.refundId).toBe('re_123');
    });
  });
});
