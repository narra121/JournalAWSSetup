import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBDocumentClient, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';
import type { APIGatewayProxyEvent } from 'aws-lambda';

// Stub env before importing handler
vi.stubEnv('SUBSCRIPTIONS_TABLE', 'test-subscriptions');
vi.stubEnv('STRIPE_SECRET_KEY_PARAM', '/test/stripeSecretKey');
vi.stubEnv('STRIPE_WEBHOOK_SECRET_PARAM', '/test/stripeWebhookSecret');

// Mock SSM
const ssmMock = mockClient(SSMClient);

// Mock DynamoDB
const ddbMock = mockClient(DynamoDBDocumentClient);

const sendEmailMock = vi.fn();
const getUserEmailMock = vi.fn();
vi.mock('../../../shared/email', async (orig) => ({
  ...(await orig<typeof import('../../../shared/email')>()),
  getUserEmail: (...a: any[]) => getUserEmailMock(...a),
  sendEmail: (...a: any[]) => sendEmailMock(...a),
}));

// Mock Stripe
const mockConstructEvent = vi.fn();
const mockSubscriptionsRetrieve = vi.fn();
const mockSubscriptionsUpdate = vi.fn();

const StripeCtor = vi.hoisted(() => vi.fn());

vi.mock('stripe', () => {
  StripeCtor.mockImplementation(function () {
    return {
      webhooks: {
        constructEvent: mockConstructEvent,
      },
      subscriptions: {
        retrieve: mockSubscriptionsRetrieve,
        update: mockSubscriptionsUpdate,
      },
    };
  });
  return { default: StripeCtor };
});

const { handler } = await import('../app.ts');
const { clearParamCache } = await import('../../../shared/stripe-config');

// ─── Helpers ────────────────────────────────────────────────────

function makeWebhookEvent(type: string, data: any) {
  return { id: 'evt_test_123', type, data: { object: data } };
}

function makeEvent(body: string, overrides: Partial<APIGatewayProxyEvent> = {}): APIGatewayProxyEvent {
  return {
    httpMethod: 'POST',
    path: '/v1/stripe/webhook',
    headers: {
      'stripe-signature': 'sig_test_valid',
      ...((overrides as any).headers || {}),
    },
    multiValueHeaders: {},
    queryStringParameters: null,
    multiValueQueryStringParameters: null,
    pathParameters: null,
    stageVariables: null,
    requestContext: {
      accountId: '123',
      apiId: 'api',
      authorizer: null,
      protocol: 'HTTP/1.1',
      httpMethod: 'POST',
      identity: {} as any,
      path: '/v1/stripe/webhook',
      stage: '$default',
      requestId: 'req-1',
      requestTimeEpoch: 0,
      resourceId: '',
      resourcePath: '/v1/stripe/webhook',
    },
    resource: '/v1/stripe/webhook',
    body,
    isBase64Encoded: false,
    ...overrides,
  } as unknown as APIGatewayProxyEvent;
}

// ─── Tests ──────────────────────────────────────────────────────

beforeEach(() => {
  clearParamCache();
  ddbMock.reset();
  ssmMock.reset();
  mockConstructEvent.mockReset();
  mockSubscriptionsRetrieve.mockReset();
  mockSubscriptionsUpdate.mockReset();
  sendEmailMock.mockReset().mockResolvedValue(undefined);
  getUserEmailMock.mockReset().mockResolvedValue(null);

  // Default SSM returns valid secrets
  ssmMock.on(GetParameterCommand).resolves({
    Parameter: { Value: 'test-secret-value' },
  });

  // Default: DDB UpdateCommand succeeds
  ddbMock.on(UpdateCommand).resolves({});
});

describe('stripe-webhook handler', () => {
  // ── Signature validation ───────────────────────────────────

  it('returns 400 when stripe-signature header is missing', async () => {
    const event = makeEvent('{}', { headers: {} });
    const res = await handler(event) as any;

    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.errorCode).toBe('MISSING_SIGNATURE');
  });

  it('returns 400 when signature verification fails', async () => {
    mockConstructEvent.mockImplementation(() => {
      throw new Error('Webhook signature verification failed');
    });

    const res = await handler(makeEvent('{"raw":"body"}')) as any;

    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.errorCode).toBe('INVALID_SIGNATURE');
  });

  // ── checkout.session.completed ─────────────────────────────

  it('handles checkout.session.completed and updates DDB with active status', async () => {
    const sessionData = {
      id: 'cs_completed_123',
      metadata: { userId: 'user-1' },
      subscription: 'sub_stripe_789',
      customer: 'cus_stripe_456',
    };
    const webhookEvent = makeWebhookEvent('checkout.session.completed', sessionData);
    mockConstructEvent.mockReturnValue(webhookEvent);

    mockSubscriptionsRetrieve.mockResolvedValue({
      id: 'sub_stripe_789',
      status: 'active',
      metadata: { userId: 'user-1' },
      items: { data: [{ price: { id: 'price_pro_monthly' } }] },
      current_period_start: 1700000000,
      current_period_end: 1702592000,
    });

    const res = await handler(makeEvent('{"raw":"body"}')) as any;

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(true);
    expect(body.data.message).toBe('Webhook processed successfully');

    // Verify DDB UpdateCommand was called
    const updateCalls = ddbMock.commandCalls(UpdateCommand);
    expect(updateCalls).toHaveLength(1);
    const updateInput = updateCalls[0].args[0].input;
    expect(updateInput.TableName).toBe('test-subscriptions');
    expect(updateInput.Key).toEqual({ userId: 'user-1' });
    expect(updateInput.ExpressionAttributeValues![':subId']).toBe('sub_stripe_789');
    expect(updateInput.ExpressionAttributeValues![':custId']).toBe('cus_stripe_456');
    expect(updateInput.ExpressionAttributeValues![':status']).toBe('active');
    expect(updateInput.ExpressionAttributeValues![':planId']).toBe('price_pro_monthly');
    expect(updateInput.ExpressionAttributeValues![':paidCount']).toBe(1);
    expect(updateInput.UpdateExpression).toContain('paidCount');
  });

  // ── invoice.paid ───────────────────────────────────────────

  it('handles invoice.paid and increments paidCount with period dates', async () => {
    const invoiceData = {
      id: 'inv_123',
      subscription: 'sub_stripe_789',
    };
    const webhookEvent = makeWebhookEvent('invoice.paid', invoiceData);
    mockConstructEvent.mockReturnValue(webhookEvent);

    mockSubscriptionsRetrieve.mockResolvedValue({
      id: 'sub_stripe_789',
      metadata: { userId: 'user-1' },
      current_period_start: 1702592000,
      current_period_end: 1705184000,
    });

    const res = await handler(makeEvent('{"raw":"body"}')) as any;

    expect(res.statusCode).toBe(200);

    const updateCalls = ddbMock.commandCalls(UpdateCommand);
    expect(updateCalls).toHaveLength(1);
    const updateInput = updateCalls[0].args[0].input;
    expect(updateInput.Key).toEqual({ userId: 'user-1' });
    expect(updateInput.UpdateExpression).toContain('paidCount');
    expect(updateInput.ExpressionAttributeValues![':inc']).toBe(1);
    expect(updateInput.ExpressionAttributeValues![':status']).toBe('active');
    expect(updateInput.ExpressionAttributeValues![':currentStart']).toBeDefined();
    expect(updateInput.ExpressionAttributeValues![':currentEnd']).toBeDefined();
  });

  it('skips invoice.paid when billing_reason is subscription_create', async () => {
    const invoiceData = {
      id: 'inv_initial_123',
      subscription: 'sub_stripe_789',
      billing_reason: 'subscription_create',
    };
    const webhookEvent = makeWebhookEvent('invoice.paid', invoiceData);
    mockConstructEvent.mockReturnValue(webhookEvent);

    const res = await handler(makeEvent('{"raw":"body"}')) as any;

    expect(res.statusCode).toBe(200);

    // No DDB update or Stripe retrieve should happen
    const updateCalls = ddbMock.commandCalls(UpdateCommand);
    expect(updateCalls).toHaveLength(0);
    expect(mockSubscriptionsRetrieve).not.toHaveBeenCalled();
  });

  // ── invoice.payment_failed ─────────────────────────────────

  it('handles invoice.payment_failed and sets status to past_due', async () => {
    const invoiceData = {
      id: 'inv_fail_123',
      subscription: 'sub_stripe_789',
    };
    const webhookEvent = makeWebhookEvent('invoice.payment_failed', invoiceData);
    mockConstructEvent.mockReturnValue(webhookEvent);

    mockSubscriptionsRetrieve.mockResolvedValue({
      id: 'sub_stripe_789',
      metadata: { userId: 'user-1' },
    });

    const res = await handler(makeEvent('{"raw":"body"}')) as any;

    expect(res.statusCode).toBe(200);

    const updateCalls = ddbMock.commandCalls(UpdateCommand);
    const updateInput = updateCalls[0].args[0].input;
    expect(updateInput.Key).toEqual({ userId: 'user-1' });
    expect(updateInput.ExpressionAttributeValues![':status']).toBe('past_due');
  });

  describe('payment failed e-mail (BE-E7)', () => {
    const failed = () => {
      mockConstructEvent.mockReturnValue(makeWebhookEvent('invoice.payment_failed', { id: 'inv_1', subscription: 'sub_1' }));
      mockSubscriptionsRetrieve.mockResolvedValue({ id: 'sub_1', metadata: { userId: 'user-1' } });
      return handler(makeEvent('{}')) as any;
    };

    it('mails the user once a day with a link to billing', async () => {
      getUserEmailMock.mockResolvedValue('u@example.com');
      const res = await failed();
      expect(res.statusCode).toBe(200);
      expect(sendEmailMock).toHaveBeenCalledTimes(1);
      expect(sendEmailMock.mock.calls[0][0]).toMatchObject({ to: 'u@example.com', subject: 'Your TradeQut payment failed' });
      expect(sendEmailMock.mock.calls[0][0].text).toContain('/app/billing');
    });

    it('does not mail again the same day (Stripe retries)', async () => {
      getUserEmailMock.mockResolvedValue('u@example.com');
      let calls = 0;
      ddbMock.on(UpdateCommand).callsFake((input) => {
        if (String(input.UpdateExpression).includes('paymentFailedEmailOn') && calls++ > 0) {
          return Promise.reject(Object.assign(new Error('c'), { name: 'ConditionalCheckFailedException' }));
        }
        return {};
      });
      await failed();
      await failed();
      expect(sendEmailMock).toHaveBeenCalledTimes(1);
    });

    it('a mail failure never fails the webhook', async () => {
      getUserEmailMock.mockResolvedValue('u@example.com');
      sendEmailMock.mockRejectedValue(new Error('SES sandbox'));
      const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      expect((await failed()).statusCode).toBe(200);
      spy.mockRestore();
    });
  });

  // ── customer.subscription.updated (cancel at period end) ───

  it('handles customer.subscription.updated with cancel_at_period_end=true', async () => {
    const subscriptionData = {
      id: 'sub_stripe_789',
      metadata: { userId: 'user-1' },
      cancel_at_period_end: true,
      pause_collection: null,
      items: { data: [{ price: { id: 'price_pro_monthly' } }] },
      current_period_start: 1700000000,
      current_period_end: 1702592000,
    };
    const webhookEvent = makeWebhookEvent('customer.subscription.updated', subscriptionData);
    mockConstructEvent.mockReturnValue(webhookEvent);
    mockSubscriptionsRetrieve.mockResolvedValue({ ...subscriptionData, status: 'active' });

    const res = await handler(makeEvent('{"raw":"body"}')) as any;

    expect(res.statusCode).toBe(200);

    const updateCalls = ddbMock.commandCalls(UpdateCommand);
    expect(updateCalls).toHaveLength(1);
    const updateInput = updateCalls[0].args[0].input;
    expect(updateInput.Key).toEqual({ userId: 'user-1' });
    expect(updateInput.ExpressionAttributeValues![':status']).toBe('cancellation_requested');
  });

  // ── customer.subscription.deleted ──────────────────────────

  it('handles customer.subscription.deleted and sets status to cancelled', async () => {
    const subscriptionData = {
      id: 'sub_stripe_789',
      metadata: { userId: 'user-1' },
    };
    const webhookEvent = makeWebhookEvent('customer.subscription.deleted', subscriptionData);
    mockConstructEvent.mockReturnValue(webhookEvent);

    const res = await handler(makeEvent('{"raw":"body"}')) as any;

    expect(res.statusCode).toBe(200);

    const updateCalls = ddbMock.commandCalls(UpdateCommand);
    expect(updateCalls).toHaveLength(1);
    const updateInput = updateCalls[0].args[0].input;
    expect(updateInput.Key).toEqual({ userId: 'user-1' });
    expect(updateInput.ExpressionAttributeValues![':status']).toBe('cancelled');
    expect(updateInput.ExpressionAttributeValues![':endedAt']).toBeDefined();
  });

  // ── Unhandled event type ───────────────────────────────────

  it('returns 200 for unhandled event types (ignores gracefully)', async () => {
    const webhookEvent = makeWebhookEvent('payment_intent.succeeded', { id: 'pi_123' });
    mockConstructEvent.mockReturnValue(webhookEvent);

    const res = await handler(makeEvent('{"raw":"body"}')) as any;

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.data.message).toBe('Webhook processed successfully');

    // No DDB calls should have been made
    const updateCalls = ddbMock.commandCalls(UpdateCommand);
    expect(updateCalls).toHaveLength(0);
  });

  // ── Base64 body decoding ───────────────────────────────────

  it('decodes base64 body when isBase64Encoded is true', async () => {
    const rawBody = '{"raw":"body"}';
    const base64Body = Buffer.from(rawBody).toString('base64');

    const sessionData = {
      id: 'cs_b64_123',
      metadata: { userId: 'user-b64' },
      subscription: 'sub_b64_789',
      customer: 'cus_b64_456',
    };
    const webhookEvent = makeWebhookEvent('checkout.session.completed', sessionData);
    mockConstructEvent.mockReturnValue(webhookEvent);

    mockSubscriptionsRetrieve.mockResolvedValue({
      id: 'sub_b64_789',
      status: 'active',
      metadata: { userId: 'user-b64' },
      items: { data: [{ price: { id: 'price_pro_monthly' } }] },
      current_period_start: 1700000000,
      current_period_end: 1702592000,
    });

    const event = makeEvent(base64Body, { isBase64Encoded: true } as any);

    const res = await handler(event) as any;

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.data.message).toBe('Webhook processed successfully');

    // Verify constructEvent received the decoded (plain text) body, not the base64 string
    expect(mockConstructEvent).toHaveBeenCalledWith(
      rawBody,
      'sig_test_valid',
      expect.any(String),
    );

    // Verify DDB was updated for the user
    const updateCalls = ddbMock.commandCalls(UpdateCommand);
    expect(updateCalls).toHaveLength(1);
    expect(updateCalls[0].args[0].input.Key).toEqual({ userId: 'user-b64' });
    expect(updateCalls[0].args[0].input.ExpressionAttributeValues![':status']).toBe('active');
  });

  // ── Internal error ─────────────────────────────────────────

  it('returns 500 when DDB update fails', async () => {
    const subscriptionData = {
      id: 'sub_stripe_789',
      metadata: { userId: 'user-1' },
    };
    const webhookEvent = makeWebhookEvent('customer.subscription.deleted', subscriptionData);
    mockConstructEvent.mockReturnValue(webhookEvent);

    ddbMock.on(UpdateCommand).rejects(new Error('DDB write error'));

    const res = await handler(makeEvent('{"raw":"body"}')) as any;

    expect(res.statusCode).toBe(500);
    const body = JSON.parse(res.body);
    expect(body.errorCode).toBe('WEBHOOK_PROCESSING_FAILED');
  });

  // ── Status mapping, ordering and replay protection ─────────

  const subscription = (over: Record<string, any> = {}) => ({
    id: 'sub_1',
    customer: 'cus_1',
    status: 'active',
    metadata: { userId: 'user-1' },
    cancel_at_period_end: false,
    pause_collection: null,
    items: { data: [{ price: { id: 'price_pro_month' } }] },
    current_period_start: 1700000000,
    current_period_end: 1702592000,
    ...over,
  });

  it.each([
    ['active', 'active'],
    ['trialing', 'active'],
    ['past_due', 'past_due'],
    ['unpaid', 'unpaid'],
    ['canceled', 'cancelled'],
    ['incomplete_expired', 'cancelled'],
  ])('maps Stripe status %s to %s', async (stripeStatus, expected) => {
    mockConstructEvent.mockReturnValue(makeWebhookEvent('customer.subscription.updated', subscription({ status: stripeStatus })));
    mockSubscriptionsRetrieve.mockResolvedValue(subscription({ status: stripeStatus }));
    await handler(makeEvent('{}'));
    expect(ddbMock.commandCalls(UpdateCommand)[0].args[0].input.ExpressionAttributeValues![':status']).toBe(expected);
  });

  it('handles customer.subscription.created like an update', async () => {
    mockConstructEvent.mockReturnValue(makeWebhookEvent('customer.subscription.created', subscription()));
    mockSubscriptionsRetrieve.mockResolvedValue(subscription());
    const res = (await handler(makeEvent('{}'))) as any;
    expect(res.statusCode).toBe(200);
    const input = ddbMock.commandCalls(UpdateCommand)[0].args[0].input;
    expect(input.ExpressionAttributeValues![':status']).toBe('active');
    expect(input.ExpressionAttributeValues![':custId']).toBe('cus_1');
  });

  it('writes #status once even when the subscription is paused and cancelling (single SET)', async () => {
    const paused = subscription({ pause_collection: { behavior: 'void' }, cancel_at_period_end: true });
    mockConstructEvent.mockReturnValue(makeWebhookEvent('customer.subscription.updated', paused));
    mockSubscriptionsRetrieve.mockResolvedValue(paused);
    await handler(makeEvent('{}'));
    const input = ddbMock.commandCalls(UpdateCommand)[0].args[0].input;
    expect(input.UpdateExpression!.match(/#status = /g)).toHaveLength(1);
    expect(input.ExpressionAttributeValues![':status']).toBe('paused');
  });

  it('guards every write with the event time so an older event cannot overwrite a newer one', async () => {
    mockConstructEvent.mockReturnValue({ ...makeWebhookEvent('customer.subscription.deleted', { id: 'sub_1', metadata: { userId: 'user-1' } }), created: 1700000500 });
    await handler(makeEvent('{}'));
    const input = ddbMock.commandCalls(UpdateCommand)[0].args[0].input;
    expect(input.ConditionExpression).toContain('lastStripeEventAt <= :eventAt');
    expect(input.ExpressionAttributeValues![':eventAt']).toBe(new Date(1700000500 * 1000).toISOString());
  });

  it('acknowledges (200) a stale or replayed event rejected by the condition', async () => {
    const err = new Error('cond');
    err.name = 'ConditionalCheckFailedException';
    ddbMock.on(UpdateCommand).rejects(err);
    mockConstructEvent.mockReturnValue(makeWebhookEvent('checkout.session.completed', { metadata: { userId: 'user-1' }, subscription: 'sub_1', customer: 'cus_1' }));
    mockSubscriptionsRetrieve.mockResolvedValue(subscription());
    const res = (await handler(makeEvent('{}'))) as any;
    expect(res.statusCode).toBe(200);
  });

  // ── Review fixes: BE-001, BE-015, BE-016, BE-017, BE-024, BE-074, BE-075 ──

  const lastUpdate = () => ddbMock.commandCalls(UpdateCommand).at(-1)!.args[0].input;

  describe('other-subscription events (BE-001)', () => {
    it.each([
      ['customer.subscription.updated', () => makeWebhookEvent('customer.subscription.updated', subscription({ id: 'sub_old' }))],
      ['customer.subscription.deleted', () => makeWebhookEvent('customer.subscription.deleted', subscription({ id: 'sub_old' }))],
      ['invoice.paid', () => makeWebhookEvent('invoice.paid', { id: 'in_1', subscription: 'sub_old' })],
      ['invoice.payment_failed', () => makeWebhookEvent('invoice.payment_failed', { id: 'in_1', subscription: 'sub_old' })],
    ])('%s applies only when the stored subscription id matches, none is stored, or the row is cancelled', async (_name, build) => {
      mockConstructEvent.mockReturnValue(build());
      mockSubscriptionsRetrieve.mockResolvedValue(subscription({ id: 'sub_old' }));
      await handler(makeEvent('{}'));
      const input = ddbMock.commandCalls(UpdateCommand)[0].args[0].input;
      expect(input.ConditionExpression).toContain(
        '(attribute_not_exists(stripeSubscriptionId) OR stripeSubscriptionId = :eventSubId OR #rowStatus = :cancelled)',
      );
      expect(input.ExpressionAttributeValues).toMatchObject({ ':eventSubId': 'sub_old', ':cancelled': 'cancelled' });
      expect(input.ExpressionAttributeNames).toMatchObject({ '#rowStatus': 'status' });
    });

    it('acknowledges (200), changes nothing and sends no mail when the row holds another subscription', async () => {
      const err = Object.assign(new Error('cond'), { name: 'ConditionalCheckFailedException' });
      ddbMock.on(UpdateCommand).rejects(err);
      getUserEmailMock.mockResolvedValue('u@example.com');
      mockConstructEvent.mockReturnValue(makeWebhookEvent('invoice.payment_failed', { id: 'in_1', subscription: 'sub_old' }));
      mockSubscriptionsRetrieve.mockResolvedValue(subscription({ id: 'sub_old' }));
      const res = (await handler(makeEvent('{}'))) as any;
      expect(res.statusCode).toBe(200);
      expect(ddbMock.commandCalls(UpdateCommand)).toHaveLength(1);
      expect(sendEmailMock).not.toHaveBeenCalled();
    });

    it('checkout.session.completed replaces the stored subscription without the id guard', async () => {
      mockConstructEvent.mockReturnValue(makeWebhookEvent('checkout.session.completed', { metadata: { userId: 'user-1' }, subscription: 'sub_2', customer: 'cus_1' }));
      mockSubscriptionsRetrieve.mockResolvedValue(subscription({ id: 'sub_2' }));
      await handler(makeEvent('{}'));
      const input = lastUpdate();
      expect(input.ConditionExpression).not.toContain('eventSubId');
      expect(input.ExpressionAttributeValues![':subId']).toBe('sub_2');
    });
  });

  describe('deleted users (BE-024)', () => {
    it.each([
      ['customer.subscription.updated', () => makeWebhookEvent('customer.subscription.updated', subscription())],
      ['customer.subscription.deleted', () => makeWebhookEvent('customer.subscription.deleted', subscription())],
      ['invoice.paid', () => makeWebhookEvent('invoice.paid', { id: 'in_1', subscription: 'sub_1' })],
      ['invoice.payment_failed', () => makeWebhookEvent('invoice.payment_failed', { id: 'in_1', subscription: 'sub_1' })],
    ])('%s needs an existing row so it cannot recreate a purged user', async (_name, build) => {
      mockConstructEvent.mockReturnValue(build());
      mockSubscriptionsRetrieve.mockResolvedValue(subscription());
      await handler(makeEvent('{}'));
      expect(ddbMock.commandCalls(UpdateCommand)[0].args[0].input.ConditionExpression).toContain('attribute_exists(userId)');
    });

    it('checkout.session.completed may create the row', async () => {
      mockConstructEvent.mockReturnValue(makeWebhookEvent('checkout.session.completed', { metadata: { userId: 'user-1' }, subscription: 'sub_1', customer: 'cus_1' }));
      mockSubscriptionsRetrieve.mockResolvedValue(subscription());
      await handler(makeEvent('{}'));
      expect(lastUpdate().ConditionExpression).not.toContain('attribute_exists(userId)');
    });

    it('the payment-failed mail marker never creates a row', async () => {
      getUserEmailMock.mockResolvedValue('u@example.com');
      mockConstructEvent.mockReturnValue(makeWebhookEvent('invoice.payment_failed', { id: 'in_1', subscription: 'sub_1' }));
      mockSubscriptionsRetrieve.mockResolvedValue(subscription());
      await handler(makeEvent('{}'));
      const marker = ddbMock.commandCalls(UpdateCommand).map((c) => c.args[0].input).find((i) => String(i.UpdateExpression).includes('paymentFailedEmailOn'));
      expect(marker?.ConditionExpression).toContain('attribute_exists(userId)');
    });
  });

  describe('admin grant markers (BE-015)', () => {
    it('customer.subscription.updated clears source and periodEnd', async () => {
      mockConstructEvent.mockReturnValue(makeWebhookEvent('customer.subscription.updated', subscription()));
      mockSubscriptionsRetrieve.mockResolvedValue(subscription());
      await handler(makeEvent('{}'));
      const input = lastUpdate();
      expect(input.UpdateExpression).toMatch(/REMOVE #src, periodEnd$/);
      expect(input.ExpressionAttributeNames).toMatchObject({ '#src': 'source' });
    });

    it('invoice.paid clears source and periodEnd', async () => {
      mockConstructEvent.mockReturnValue(makeWebhookEvent('invoice.paid', { id: 'in_1', subscription: 'sub_1' }));
      mockSubscriptionsRetrieve.mockResolvedValue(subscription());
      await handler(makeEvent('{}'));
      const input = lastUpdate();
      expect(input.UpdateExpression).toMatch(/REMOVE #src, periodEnd$/);
      expect(input.ExpressionAttributeNames).toMatchObject({ '#src': 'source' });
    });
  });

  describe('current state wins over the event snapshot (BE-016)', () => {
    it('writes the retrieved status and period when a stale "incomplete" snapshot arrives last', async () => {
      mockConstructEvent.mockReturnValue(
        makeWebhookEvent('customer.subscription.created', subscription({ status: 'incomplete', current_period_end: 1700000100 })),
      );
      mockSubscriptionsRetrieve.mockResolvedValue(subscription({ status: 'active', current_period_end: 1702592000 }));
      await handler(makeEvent('{}'));
      expect(mockSubscriptionsRetrieve).toHaveBeenCalledWith('sub_1');
      const values = lastUpdate().ExpressionAttributeValues!;
      expect(values[':status']).toBe('active');
      expect(values[':currentEnd']).toBe(new Date(1702592000 * 1000).toISOString());
    });

    it('does not re-label an ended subscription as cancellation_requested', async () => {
      mockConstructEvent.mockReturnValue(makeWebhookEvent('customer.subscription.updated', subscription()));
      mockSubscriptionsRetrieve.mockResolvedValue(subscription({ status: 'canceled', cancel_at_period_end: true }));
      await handler(makeEvent('{}'));
      expect(lastUpdate().ExpressionAttributeValues![':status']).toBe('cancelled');
    });
  });

  describe('checkout.session.completed status (BE-075)', () => {
    const completed = () => makeWebhookEvent('checkout.session.completed', { metadata: { userId: 'user-1' }, subscription: 'sub_1', customer: 'cus_1' });

    it.each([
      ['incomplete', {}, 'incomplete'],
      ['past_due', {}, 'past_due'],
      ['trialing', {}, 'active'],
      ['active', { cancel_at_period_end: true }, 'cancellation_requested'],
      ['active', { pause_collection: { behavior: 'void' } }, 'paused'],
    ])('stores the retrieved %s subscription %j as %s', async (status, over, expected) => {
      mockConstructEvent.mockReturnValue(completed());
      mockSubscriptionsRetrieve.mockResolvedValue(subscription({ status, ...over }));
      await handler(makeEvent('{}'));
      expect(lastUpdate().ExpressionAttributeValues![':status']).toBe(expected);
    });
  });

  describe('configuration (BE-074)', () => {
    it('fails with a logged configuration error, not a signature error, when the webhook secret is missing', async () => {
      const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      ssmMock.on(GetParameterCommand).rejects(Object.assign(new Error('nf'), { name: 'ParameterNotFound' }));
      const res = (await handler(makeEvent('{}'))) as any;
      expect(res.statusCode).toBe(500);
      expect(JSON.parse(res.body).errorCode).toBe('WEBHOOK_PROCESSING_FAILED');
      expect(spy.mock.calls.some((c) => c[0] === 'stripe_webhook_failed' && /webhook secret not found/.test(c[1]?.error))).toBe(true);
      expect(mockConstructEvent).not.toHaveBeenCalled();
      spy.mockRestore();
    });

    it('builds the shared Stripe client with a timeout under the CloudFront limit and network retries', async () => {
      mockConstructEvent.mockReturnValue(makeWebhookEvent('payment_intent.succeeded', { id: 'pi_1' }));
      await handler(makeEvent('{}'));
      expect(StripeCtor).toHaveBeenCalledWith('test-secret-value', { timeout: 20000, maxNetworkRetries: 2 });
    });
  });

  it('logs stripe_webhook_failed when processing throws', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    ddbMock.on(UpdateCommand).rejects(new Error('boom'));
    mockConstructEvent.mockReturnValue(makeWebhookEvent('customer.subscription.deleted', { id: 'sub_1', metadata: { userId: 'user-1' } }));
    await handler(makeEvent('{}'));
    expect(spy.mock.calls.some((c) => c[0] === 'stripe_webhook_failed')).toBe(true);
    spy.mockRestore();
  });
});
