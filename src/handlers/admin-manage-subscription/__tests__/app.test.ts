import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBDocumentClient, UpdateCommand, GetCommand } from '@aws-sdk/lib-dynamodb';
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';
import type { APIGatewayProxyEventV2 } from 'aws-lambda';

// ─── Env ───────────────────────────────────────────────────────
vi.stubEnv('SUBSCRIPTIONS_TABLE', 'test-subscriptions');
vi.stubEnv('STRIPE_SECRET_KEY_PARAM', '/tradequt/dev/stripeSecretKey');

// ─── Stripe mock ─────────────────────────────────────────────
const { refundCreate, subscriptionsCancel, invoicesList } = vi.hoisted(() => ({
  refundCreate: vi.fn(),
  subscriptionsCancel: vi.fn(),
  invoicesList: vi.fn(),
}));
vi.mock('stripe', () => ({
  default: vi.fn().mockImplementation(function () {
    return {
      refunds: { create: refundCreate },
      invoices: { list: invoicesList },
      subscriptions: { cancel: subscriptionsCancel },
    };
  }),
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
    default: vi.fn().mockImplementation(function () {
      return {
        refunds: { create: refundCreate },
        invoices: { list: invoicesList },
        subscriptions: { cancel: subscriptionsCancel },
      };
    }),
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
  refundCreate.mockReset().mockResolvedValue({ id: 're_123' });
  subscriptionsCancel.mockReset().mockResolvedValue({});
  invoicesList.mockReset().mockResolvedValue({ data: [{ id: 'inv_123', payment_intent: 'pi_123' }] });
});

const updates = () => ddbMock.commandCalls(UpdateCommand).map((c) => c.args[0].input);
const setValues = (input: any) =>
  Object.fromEntries(Object.entries(input.ExpressionAttributeNames).map(([k, v], i) => [v, input.ExpressionAttributeValues[`:v${i}`]]));

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

  describe('request validation (BE-070)', () => {
    it('returns 400 for malformed JSON instead of 500', async () => {
      const handler = await freshHandler();
      const event = makeEvent('user-1');
      event.body = '{not json';
      const res = (await handler(event, {} as any, () => {})) as any;
      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body).message).toContain('Invalid JSON');
    });

    it.each([['null'], ['[1]'], ['"x"']])('returns 400 for a non-object body %s', async (raw) => {
      const handler = await freshHandler();
      const event = makeEvent('user-1');
      event.body = raw;
      expect(((await handler(event, {} as any, () => {})) as any).statusCode).toBe(400);
    });

    it.each([['x'], [-3], [0], [1.5], [null]])('rejects period %j with 400 and writes nothing', async (period) => {
      const handler = await freshHandler();
      ddbMock.on(UpdateCommand).resolves({});
      const res = (await handler(makeEvent('user-1', { action: 'grant_free', period, unit: 'months' }), {} as any, () => {})) as any;
      expect(res.statusCode).toBe(400);
      expect(updates()).toHaveLength(0);
    });

    it('rejects an unknown unit with 400', async () => {
      const handler = await freshHandler();
      const res = (await handler(makeEvent('user-1', { action: 'grant_free', period: 2, unit: 'weeks' }), {} as any, () => {})) as any;
      expect(res.statusCode).toBe(400);
      expect(updates()).toHaveLength(0);
    });
  });

  describe('grant_free', () => {
    it('grants 30-day subscription by default', async () => {
      const handler = await freshHandler();
      ddbMock.on(UpdateCommand).resolves({});

      const res = await handler(makeEvent('user-1', { action: 'grant_free' }), {} as any, () => {}) as any;
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(true);
      expect(body.data.userId).toBe('user-1');
      expect(body.data.status).toBe('active');
      expect(body.data.periodEnd).toBeDefined();

      expect(updates()).toHaveLength(1);
      expect(updates()[0].Key).toEqual({ userId: 'user-1' });
      expect(setValues(updates()[0])).toMatchObject({ status: 'active', tier: 'active', source: 'admin_grant' });
      expect(updates()[0].UpdateExpression).not.toContain('REMOVE');
    });

    it('adds calendar months, not 30-day blocks', async () => {
      const handler = await freshHandler();
      ddbMock.on(UpdateCommand).resolves({});
      const res = (await handler(makeEvent('user-1', { action: 'grant_free', period: 12, unit: 'months' }), {} as any, () => {})) as any;
      const end = new Date(JSON.parse(res.body).data.periodEnd);
      const expected = new Date();
      expected.setMonth(expected.getMonth() + 12);
      expect(Math.abs(end.getTime() - expected.getTime())).toBeLessThan(5000);
    });

    it('grants lifetime subscription when unit is lifetime', async () => {
      const handler = await freshHandler();
      ddbMock.on(UpdateCommand).resolves({});

      const res = await handler(makeEvent('user-1', { action: 'grant_free', unit: 'lifetime' }), {} as any, () => {}) as any;
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.data.periodEnd).toBe('9999-12-31T23:59:59.000Z');

      expect(setValues(updates()[0]).periodEnd).toBe('9999-12-31T23:59:59.000Z');
    });
  });

  describe('cancel', () => {
    it('cancels the subscription and the Stripe subscription, keeping the Stripe ids', async () => {
      const handler = await freshHandler();
      setupSsm();
      ddbMock.on(GetCommand).resolves({ Item: { userId: 'user-1', stripeSubscriptionId: 'sub_9', stripeCustomerId: 'cus_9' } });
      ddbMock.on(UpdateCommand).resolves({});

      const res = await handler(makeEvent('user-1', { action: 'cancel' }), {} as any, () => {}) as any;
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(true);
      expect(body.data.status).toBe('cancelled');

      expect(subscriptionsCancel).toHaveBeenCalledWith('sub_9');
      expect(setValues(updates()[0])).toMatchObject({ status: 'cancelled', source: 'admin_cancel' });
      expect(Object.keys(setValues(updates()[0]))).not.toContain('stripeCustomerId');
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
        Item: { userId: 'user-1', stripeCustomerId: 'cus_123', stripeSubscriptionId: 'sub_123' },
      });
      ddbMock.on(UpdateCommand).resolves({});

      const res = await handler(makeEvent('user-1', { action: 'refund' }), {} as any, () => {}) as any;
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(true);
      expect(body.data.status).toBe('cancelled');
      expect(body.data.refundId).toBe('re_123');

      expect(refundCreate).toHaveBeenCalledWith({ payment_intent: 'pi_123' });
      expect(subscriptionsCancel).toHaveBeenCalledWith('sub_123');
      expect(setValues(updates()[0])).toMatchObject({ status: 'cancelled', source: 'admin_refund', refundId: 're_123' });
    });

    it('refunds the newest PAID invoice, not the newest invoice of any status (BE-070)', async () => {
      const handler = await freshHandler();
      setupSsm();
      ddbMock.on(GetCommand).resolves({ Item: { userId: 'user-1', stripeCustomerId: 'cus_123', stripeSubscriptionId: 'sub_123' } });
      ddbMock.on(UpdateCommand).resolves({});
      await handler(makeEvent('user-1', { action: 'refund' }), {} as any, () => {});
      expect(invoicesList).toHaveBeenCalledWith({ customer: 'cus_123', status: 'paid', limit: 1 });
    });

    it('cancels the subscription before refunding, so a failed refund leaves a retryable state (BE-070)', async () => {
      const handler = await freshHandler();
      setupSsm();
      ddbMock.on(GetCommand).resolves({ Item: { userId: 'user-1', stripeCustomerId: 'cus_123', stripeSubscriptionId: 'sub_123' } });
      ddbMock.on(UpdateCommand).resolves({});
      await handler(makeEvent('user-1', { action: 'refund' }), {} as any, () => {});
      expect(subscriptionsCancel.mock.invocationCallOrder[0]).toBeLessThan(refundCreate.mock.invocationCallOrder[0]);
    });

    it('a retry after a failed refund still reaches the refund when the subscription is already cancelled', async () => {
      const handler = await freshHandler();
      setupSsm();
      subscriptionsCancel.mockRejectedValue(Object.assign(new Error('No such subscription: sub_123'), { code: 'resource_missing' }));
      ddbMock.on(GetCommand).resolves({ Item: { userId: 'user-1', stripeCustomerId: 'cus_123', stripeSubscriptionId: 'sub_123' } });
      ddbMock.on(UpdateCommand).resolves({});
      const res = (await handler(makeEvent('user-1', { action: 'refund' }), {} as any, () => {})) as any;
      expect(res.statusCode).toBe(200);
      expect(refundCreate).toHaveBeenCalledTimes(1);
    });

    it('says so when the customer has no paid invoice', async () => {
      const handler = await freshHandler();
      setupSsm();
      invoicesList.mockResolvedValue({ data: [] });
      ddbMock.on(GetCommand).resolves({ Item: { userId: 'user-1', stripeCustomerId: 'cus_123', stripeSubscriptionId: 'sub_123' } });
      const res = (await handler(makeEvent('user-1', { action: 'refund' }), {} as any, () => {})) as any;
      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body).message).toContain('paid invoices');
      expect(subscriptionsCancel).not.toHaveBeenCalled();
    });
  });
});
