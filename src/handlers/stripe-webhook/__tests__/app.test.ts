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

// Mock Stripe
const mockConstructEvent = vi.fn();
const mockSubscriptionsRetrieve = vi.fn();
const mockSubscriptionsUpdate = vi.fn();

vi.mock('stripe', () => {
  return {
    default: vi.fn().mockImplementation(() => ({
      webhooks: {
        constructEvent: mockConstructEvent,
      },
      subscriptions: {
        retrieve: mockSubscriptionsRetrieve,
        update: mockSubscriptionsUpdate,
      },
    })),
  };
});

const { handler } = await import('../app.ts');

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
  ddbMock.reset();
  ssmMock.reset();
  mockConstructEvent.mockReset();
  mockSubscriptionsRetrieve.mockReset();
  mockSubscriptionsUpdate.mockReset();

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
    expect(body.error.code).toBe('MISSING_SIGNATURE');
  });

  it('returns 400 when signature verification fails', async () => {
    mockConstructEvent.mockImplementation(() => {
      throw new Error('Webhook signature verification failed');
    });

    const res = await handler(makeEvent('{"raw":"body"}')) as any;

    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.error.code).toBe('INVALID_SIGNATURE');
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
      metadata: { userId: 'user-1' },
      items: { data: [{ price: { id: 'price_pro_monthly' } }] },
      current_period_start: 1700000000,
      current_period_end: 1702592000,
    });

    const res = await handler(makeEvent('{"raw":"body"}')) as any;

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.data.message).toBe('Webhook processed successfully');

    // Verify DDB UpdateCommand was called
    const updateCalls = ddbMock.commandCalls(UpdateCommand);
    expect(updateCalls).toHaveLength(1);
    const updateInput = updateCalls[0].args[0].input;
    expect(updateInput.TableName).toBe('test-subscriptions');
    expect(updateInput.Key).toEqual({ userId: 'user-1' });
    expect(updateInput.ExpressionAttributeValues[':subId']).toBe('sub_stripe_789');
    expect(updateInput.ExpressionAttributeValues[':custId']).toBe('cus_stripe_456');
    expect(updateInput.ExpressionAttributeValues[':status']).toBe('active');
    expect(updateInput.ExpressionAttributeValues[':planId']).toBe('price_pro_monthly');
    // paidCount is no longer set by checkout handler (handleInvoicePaid is sole owner)
    expect(updateInput.ExpressionAttributeValues[':paidCount']).toBeUndefined();
    expect(updateInput.UpdateExpression).not.toContain('paidCount');
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
    expect(updateInput.ExpressionAttributeValues[':inc']).toBe(1);
    expect(updateInput.ExpressionAttributeValues[':status']).toBe('active');
    expect(updateInput.ExpressionAttributeValues[':currentStart']).toBeDefined();
    expect(updateInput.ExpressionAttributeValues[':currentEnd']).toBeDefined();
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
    expect(updateCalls).toHaveLength(1);
    const updateInput = updateCalls[0].args[0].input;
    expect(updateInput.Key).toEqual({ userId: 'user-1' });
    expect(updateInput.ExpressionAttributeValues[':status']).toBe('past_due');
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

    const res = await handler(makeEvent('{"raw":"body"}')) as any;

    expect(res.statusCode).toBe(200);

    const updateCalls = ddbMock.commandCalls(UpdateCommand);
    expect(updateCalls).toHaveLength(1);
    const updateInput = updateCalls[0].args[0].input;
    expect(updateInput.Key).toEqual({ userId: 'user-1' });
    expect(updateInput.ExpressionAttributeValues[':status']).toBe('cancellation_requested');
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
    expect(updateInput.ExpressionAttributeValues[':status']).toBe('cancelled');
    expect(updateInput.ExpressionAttributeValues[':endedAt']).toBeDefined();
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
    expect(body.error.code).toBe('WEBHOOK_PROCESSING_FAILED');
  });
});
