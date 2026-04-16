import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBDocumentClient, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';
import type { APIGatewayProxyEvent } from 'aws-lambda';

// Stub env before importing handler
vi.stubEnv('SUBSCRIPTIONS_TABLE', 'test-subscriptions');
vi.stubEnv('STRIPE_SECRET_KEY_PARAM', '/test/stripeSecretKey');

// ─── Mock AWS clients ───────────────────────────────────────────
const ddbMock = mockClient(DynamoDBDocumentClient);
const ssmMock = mockClient(SSMClient);

// ─── Mock Stripe ────────────────────────────────────────────────
const mockSessionsRetrieve = vi.fn();

vi.mock('stripe', () => {
  return {
    default: vi.fn().mockImplementation(() => ({
      checkout: {
        sessions: {
          retrieve: mockSessionsRetrieve,
        },
      },
    })),
  };
});

const { handler } = await import('../app.ts');

// ─── Helpers ────────────────────────────────────────────────────

function makeJwt(sub: string): string {
  const header = btoa(JSON.stringify({ alg: 'RS256' }));
  const payload = btoa(JSON.stringify({ sub }));
  return `${header}.${payload}.sig`;
}

function makeEvent(
  queryParams?: Record<string, string> | null,
  overrides: Partial<APIGatewayProxyEvent> = {},
): APIGatewayProxyEvent {
  return {
    httpMethod: 'GET',
    path: '/v1/subscriptions/verify',
    headers: {
      authorization: `Bearer ${makeJwt('user-1')}`,
      origin: 'https://tradequt.com',
      ...((overrides as any).headers || {}),
    },
    multiValueHeaders: {},
    queryStringParameters: queryParams || null,
    multiValueQueryStringParameters: null,
    pathParameters: null,
    stageVariables: null,
    requestContext: {
      accountId: '123',
      apiId: 'api',
      authorizer: null,
      protocol: 'HTTP/1.1',
      httpMethod: 'GET',
      identity: {} as any,
      path: '/v1/subscriptions/verify',
      stage: '$default',
      requestId: 'req-1',
      requestTimeEpoch: 0,
      resourceId: '',
      resourcePath: '/v1/subscriptions/verify',
    },
    resource: '/v1/subscriptions/verify',
    body: null,
    isBase64Encoded: false,
    ...overrides,
  } as unknown as APIGatewayProxyEvent;
}

function makeStripeSession(overrides: Record<string, any> = {}): any {
  return {
    id: 'cs_test_123',
    status: 'complete',
    payment_status: 'paid',
    metadata: { userId: 'user-1' },
    client_reference_id: 'user-1',
    customer: 'cus_test_abc',
    subscription: {
      id: 'sub_test_xyz',
      current_period_start: Math.floor(Date.now() / 1000) - 86400 * 15,
      current_period_end: Math.floor(Date.now() / 1000) + 86400 * 15,
      items: {
        data: [{ price: { id: 'price_pro_monthly' } }],
      },
    },
    ...overrides,
  };
}

// ─── Tests ──────────────────────────────────────────────────────

beforeEach(() => {
  ddbMock.reset();
  ssmMock.reset();
  mockSessionsRetrieve.mockReset();

  // Default SSM returns a valid Stripe key
  ssmMock.on(GetParameterCommand).resolves({
    Parameter: { Value: 'sk_test_fake_key_123' },
  });

  // Default: DDB UpdateCommand succeeds
  ddbMock.on(UpdateCommand).resolves({});

  // Default: Stripe session retrieval succeeds with complete+paid
  mockSessionsRetrieve.mockResolvedValue(makeStripeSession());
});

describe('verify-checkout-session handler', () => {
  // ── Auth ────────────────────────────────────────────────────

  it('returns 401 when no auth header', async () => {
    const event = makeEvent({ session_id: 'cs_test_123' }, { headers: {} });
    const res = await handler(event) as any;

    expect(res.statusCode).toBe(401);
    const body = JSON.parse(res.body);
    expect(body.errorCode).toBe('UNAUTHORIZED');
    expect(body.message).toContain('Unauthorized');
  });

  it('returns 401 when auth header has invalid JWT', async () => {
    const event = makeEvent({ session_id: 'cs_test_123' }, {
      headers: { authorization: 'Bearer invalid-token' },
    } as any);
    const res = await handler(event) as any;

    expect(res.statusCode).toBe(401);
    const body = JSON.parse(res.body);
    expect(body.errorCode).toBe('UNAUTHORIZED');
  });

  // ── Validation ─────────────────────────────────────────────

  it('returns 400 when session_id query parameter is missing', async () => {
    const event = makeEvent(null);
    const res = await handler(event) as any;

    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.errorCode).toBe('VALIDATION_ERROR');
    expect(body.message).toContain('session_id');
  });

  it('returns 400 when queryStringParameters is empty object without session_id', async () => {
    const event = makeEvent({});
    const res = await handler(event) as any;

    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.errorCode).toBe('VALIDATION_ERROR');
    expect(body.message).toContain('session_id');
  });

  // ── Session ownership verification ────────────────────────

  it('returns 403 when session does not belong to user (metadata mismatch)', async () => {
    mockSessionsRetrieve.mockResolvedValue(makeStripeSession({
      metadata: { userId: 'other-user' },
      client_reference_id: 'other-user',
    }));

    const event = makeEvent({ session_id: 'cs_test_123' });
    const res = await handler(event) as any;

    expect(res.statusCode).toBe(403);
    const body = JSON.parse(res.body);
    expect(body.errorCode).toBe('UNAUTHORIZED');
    expect(body.message).toContain('does not belong');
  });

  it('allows access when metadata.userId matches but client_reference_id does not', async () => {
    mockSessionsRetrieve.mockResolvedValue(makeStripeSession({
      metadata: { userId: 'user-1' },
      client_reference_id: 'other-user',
    }));

    const event = makeEvent({ session_id: 'cs_test_123' });
    const res = await handler(event) as any;

    expect(res.statusCode).toBe(200);
  });

  it('allows access when client_reference_id matches but metadata.userId does not', async () => {
    mockSessionsRetrieve.mockResolvedValue(makeStripeSession({
      metadata: { userId: 'other-user' },
      client_reference_id: 'user-1',
    }));

    const event = makeEvent({ session_id: 'cs_test_123' });
    const res = await handler(event) as any;

    expect(res.statusCode).toBe(200);
  });

  // ── Complete + Paid session (active subscription) ─────────

  it('returns active status and updates DDB for complete+paid session with subscription', async () => {
    const session = makeStripeSession();
    mockSessionsRetrieve.mockResolvedValue(session);

    const event = makeEvent({ session_id: 'cs_test_123' });
    const res = await handler(event) as any;

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(true);
    expect(body.data.status).toBe('active');
    expect(body.data.subscriptionId).toBe('sub_test_xyz');
    expect(body.data.message).toContain('Payment successful');
    expect(body.data.message).toContain('active');

    // Verify Stripe was called with correct session ID and expand
    expect(mockSessionsRetrieve).toHaveBeenCalledWith('cs_test_123', {
      expand: ['subscription'],
    });

    // Verify DDB UpdateCommand was called with correct fields
    const updateCalls = ddbMock.commandCalls(UpdateCommand);
    expect(updateCalls).toHaveLength(1);
    const input = updateCalls[0].args[0].input;
    expect(input.TableName).toBe('test-subscriptions');
    expect(input.Key).toEqual({ userId: 'user-1' });
    expect(input.ExpressionAttributeValues).toMatchObject({
      ':active': 'active',
      ':subId': 'sub_test_xyz',
      ':custId': 'cus_test_abc',
      ':planId': 'price_pro_monthly',
    });
    expect(input.ExpressionAttributeValues![':periodStart']).toBeDefined();
    expect(input.ExpressionAttributeValues![':periodEnd']).toBeDefined();
    expect(input.ExpressionAttributeValues![':now']).toBeDefined();
  });

  it('handles customer as object (not string) in complete+paid session', async () => {
    mockSessionsRetrieve.mockResolvedValue(makeStripeSession({
      customer: { id: 'cus_object_123', email: 'test@test.com' },
    }));

    const event = makeEvent({ session_id: 'cs_test_123' });
    const res = await handler(event) as any;

    expect(res.statusCode).toBe(200);
    const updateCalls = ddbMock.commandCalls(UpdateCommand);
    expect(updateCalls).toHaveLength(1);
    const input = updateCalls[0].args[0].input;
    expect(input.ExpressionAttributeValues![':custId']).toBe('cus_object_123');
  });

  it('handles subscription as string ID in response data', async () => {
    // When subscription is a string (not expanded), the response should still return it
    mockSessionsRetrieve.mockResolvedValue(makeStripeSession({
      subscription: 'sub_string_only',
      status: 'complete',
      payment_status: 'paid',
    }));

    const event = makeEvent({ session_id: 'cs_test_123' });
    const res = await handler(event) as any;

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.data.status).toBe('active');
    // When subscription is a string, DDB update is skipped (no sub.id)
    // But the response should still include the subscription ID
  });

  it('does not update DDB when subscription is null on complete+paid session', async () => {
    mockSessionsRetrieve.mockResolvedValue(makeStripeSession({
      subscription: null,
    }));

    const event = makeEvent({ session_id: 'cs_test_123' });
    const res = await handler(event) as any;

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.data.status).toBe('active');

    // Verify DDB was NOT called since subscription is null
    const updateCalls = ddbMock.commandCalls(UpdateCommand);
    expect(updateCalls).toHaveLength(0);
  });

  it('converts period timestamps from seconds to ISO strings', async () => {
    const periodStart = 1700000000; // fixed timestamp in seconds
    const periodEnd = 1702592000;
    mockSessionsRetrieve.mockResolvedValue(makeStripeSession({
      subscription: {
        id: 'sub_test_xyz',
        current_period_start: periodStart,
        current_period_end: periodEnd,
        items: { data: [{ price: { id: 'price_test' } }] },
      },
    }));

    const event = makeEvent({ session_id: 'cs_test_123' });
    await handler(event);

    const updateCalls = ddbMock.commandCalls(UpdateCommand);
    expect(updateCalls).toHaveLength(1);
    const input = updateCalls[0].args[0].input;
    expect(input.ExpressionAttributeValues![':periodStart']).toBe(
      new Date(periodStart * 1000).toISOString()
    );
    expect(input.ExpressionAttributeValues![':periodEnd']).toBe(
      new Date(periodEnd * 1000).toISOString()
    );
  });

  // ── Expired session ───────────────────────────────────────

  it('returns expired status for expired session', async () => {
    mockSessionsRetrieve.mockResolvedValue(makeStripeSession({
      status: 'expired',
      payment_status: 'unpaid',
    }));

    const event = makeEvent({ session_id: 'cs_test_expired' });
    const res = await handler(event) as any;

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(true);
    expect(body.data.status).toBe('expired');
    expect(body.data.message).toContain('expired');
    expect(body.data.message).toContain('try again');

    // Verify DDB was NOT updated for expired sessions
    const updateCalls = ddbMock.commandCalls(UpdateCommand);
    expect(updateCalls).toHaveLength(0);
  });

  // ── Open/Pending sessions ─────────────────────────────────

  it('returns pending status for open session', async () => {
    mockSessionsRetrieve.mockResolvedValue(makeStripeSession({
      status: 'open',
      payment_status: 'unpaid',
    }));

    const event = makeEvent({ session_id: 'cs_test_open' });
    const res = await handler(event) as any;

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(true);
    expect(body.data.status).toBe('pending');
    expect(body.data.message).toContain('still being processed');

    // Verify DDB was NOT updated for pending sessions
    const updateCalls = ddbMock.commandCalls(UpdateCommand);
    expect(updateCalls).toHaveLength(0);
  });

  it('returns pending status for complete but unpaid session', async () => {
    mockSessionsRetrieve.mockResolvedValue(makeStripeSession({
      status: 'complete',
      payment_status: 'unpaid',
    }));

    const event = makeEvent({ session_id: 'cs_test_unpaid' });
    const res = await handler(event) as any;

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.data.status).toBe('pending');

    // Verify DDB was NOT updated for unpaid sessions
    const updateCalls = ddbMock.commandCalls(UpdateCommand);
    expect(updateCalls).toHaveLength(0);
  });

  it('returns pending status for complete with no_payment_required', async () => {
    mockSessionsRetrieve.mockResolvedValue(makeStripeSession({
      status: 'complete',
      payment_status: 'no_payment_required',
    }));

    const event = makeEvent({ session_id: 'cs_test_no_payment' });
    const res = await handler(event) as any;

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.data.status).toBe('pending');
  });

  // ── StripeInvalidRequestError ─────────────────────────────

  it('returns 400 for StripeInvalidRequestError (invalid session ID)', async () => {
    const stripeError = new Error('No such checkout.session: cs_invalid');
    (stripeError as any).type = 'StripeInvalidRequestError';
    mockSessionsRetrieve.mockRejectedValue(stripeError);

    const event = makeEvent({ session_id: 'cs_invalid' });
    const res = await handler(event) as any;

    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.errorCode).toBe('VALIDATION_ERROR');
    expect(body.message).toContain('Invalid checkout session ID');
  });

  // ── Generic errors ────────────────────────────────────────

  it('returns 500 for generic Stripe API errors', async () => {
    mockSessionsRetrieve.mockRejectedValue(new Error('Stripe network timeout'));

    const event = makeEvent({ session_id: 'cs_test_123' });
    const res = await handler(event) as any;

    expect(res.statusCode).toBe(500);
    const body = JSON.parse(res.body);
    expect(body.errorCode).toBe('INTERNAL_ERROR');
    expect(body.message).toContain('Failed to verify checkout session');
  });

  it('returns 500 when DDB update fails', async () => {
    ddbMock.on(UpdateCommand).rejects(new Error('DynamoDB write failure'));

    const event = makeEvent({ session_id: 'cs_test_123' });
    const res = await handler(event) as any;

    expect(res.statusCode).toBe(500);
    const body = JSON.parse(res.body);
    expect(body.errorCode).toBe('INTERNAL_ERROR');
    expect(body.message).toContain('Failed to verify checkout session');
  });

  // ── Edge cases ────────────────────────────────────────────

  it('handles subscription with missing items/price gracefully', async () => {
    mockSessionsRetrieve.mockResolvedValue(makeStripeSession({
      subscription: {
        id: 'sub_no_items',
        current_period_start: Math.floor(Date.now() / 1000),
        current_period_end: Math.floor(Date.now() / 1000) + 86400 * 30,
        items: { data: [] },
      },
    }));

    const event = makeEvent({ session_id: 'cs_test_123' });
    const res = await handler(event) as any;

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.data.status).toBe('active');

    const updateCalls = ddbMock.commandCalls(UpdateCommand);
    expect(updateCalls).toHaveLength(1);
    const input = updateCalls[0].args[0].input;
    expect(input.ExpressionAttributeValues![':planId']).toBe('');
  });

  it('handles customer being empty string', async () => {
    mockSessionsRetrieve.mockResolvedValue(makeStripeSession({
      customer: '',
    }));

    const event = makeEvent({ session_id: 'cs_test_123' });
    const res = await handler(event) as any;

    expect(res.statusCode).toBe(200);
    const updateCalls = ddbMock.commandCalls(UpdateCommand);
    expect(updateCalls).toHaveLength(1);
    const input = updateCalls[0].args[0].input;
    expect(input.ExpressionAttributeValues![':custId']).toBe('');
  });

  it('handles subscription with zero period timestamps', async () => {
    mockSessionsRetrieve.mockResolvedValue(makeStripeSession({
      subscription: {
        id: 'sub_zero_periods',
        current_period_start: 0,
        current_period_end: 0,
        items: { data: [{ price: { id: 'price_test' } }] },
      },
    }));

    const event = makeEvent({ session_id: 'cs_test_123' });
    const res = await handler(event) as any;

    expect(res.statusCode).toBe(200);
    const updateCalls = ddbMock.commandCalls(UpdateCommand);
    expect(updateCalls).toHaveLength(1);
    const input = updateCalls[0].args[0].input;
    expect(input.ExpressionAttributeValues![':periodStart']).toBe(new Date(0).toISOString());
    expect(input.ExpressionAttributeValues![':periodEnd']).toBe(new Date(0).toISOString());
  });
});
