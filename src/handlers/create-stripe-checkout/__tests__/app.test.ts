import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBDocumentClient, GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';
import type { APIGatewayProxyEvent } from 'aws-lambda';

// Stub env before importing handler
vi.stubEnv('SUBSCRIPTIONS_TABLE', 'test-subscriptions');
vi.stubEnv('STRIPE_SECRET_KEY_PARAM', '/test/stripeSecretKey');

// Mock SSM
const ssmMock = mockClient(SSMClient);

// Mock DynamoDB
const ddbMock = mockClient(DynamoDBDocumentClient);

// Mock Stripe
const mockSessionsCreate = vi.fn().mockResolvedValue({
  id: 'cs_test_123',
  url: 'https://checkout.stripe.com/test',
});

vi.mock('stripe', () => {
  return {
    default: vi.fn().mockImplementation(() => ({
      checkout: {
        sessions: {
          create: mockSessionsCreate,
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

function makeEvent(body?: any, overrides: Partial<APIGatewayProxyEvent> = {}): APIGatewayProxyEvent {
  return {
    httpMethod: 'POST',
    path: '/v1/subscriptions',
    headers: {
      authorization: `Bearer ${makeJwt('user-1')}`,
      origin: 'https://tradequt.com',
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
      path: '/v1/subscriptions',
      stage: '$default',
      requestId: 'req-1',
      requestTimeEpoch: 0,
      resourceId: '',
      resourcePath: '/v1/subscriptions',
    },
    resource: '/v1/subscriptions',
    body: body !== undefined ? JSON.stringify(body) : null,
    isBase64Encoded: false,
    ...overrides,
  } as unknown as APIGatewayProxyEvent;
}

// ─── Tests ──────────────────────────────────────────────────────

beforeEach(() => {
  ddbMock.reset();
  ssmMock.reset();
  mockSessionsCreate.mockReset();

  // Default SSM returns a valid Stripe key
  ssmMock.on(GetParameterCommand).resolves({
    Parameter: { Value: 'sk_test_fake_key_123' },
  });

  // Default: no existing subscription
  ddbMock.on(GetCommand).resolves({ Item: undefined });

  // Default: PutCommand succeeds
  ddbMock.on(PutCommand).resolves({});

  // Default: Stripe session creation succeeds
  mockSessionsCreate.mockResolvedValue({
    id: 'cs_test_123',
    url: 'https://checkout.stripe.com/test',
  });
});

describe('create-stripe-checkout handler', () => {
  // ── Auth ────────────────────────────────────────────────────

  it('returns 401 when no auth header', async () => {
    const event = makeEvent({ planId: 'price_123' }, { headers: {} });
    const res = await handler(event) as any;

    expect(res.statusCode).toBe(401);
    const body = JSON.parse(res.body);
    expect(body.errorCode).toBe('UNAUTHORIZED');
  });

  // ── Validation ─────────────────────────────────────────────

  it('returns 400 when body is missing', async () => {
    const event = makeEvent(undefined);
    event.body = null;
    const res = await handler(event) as any;

    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.errorCode).toBe('VALIDATION_ERROR');
    expect(body.message).toContain('Missing body');
  });

  it('returns 400 when planId is missing', async () => {
    const res = await handler(makeEvent({ successUrl: 'https://example.com' })) as any;

    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.errorCode).toBe('VALIDATION_ERROR');
    expect(body.message).toContain('planId');
  });

  // ── Existing subscription checks ──────────────────────────

  it('returns 400 when user already has active subscription', async () => {
    ddbMock.on(GetCommand).resolves({
      Item: {
        userId: 'user-1',
        status: 'active',
        planId: 'price_existing',
      },
    });

    const res = await handler(makeEvent({ planId: 'price_123' })) as any;

    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.errorCode).toBe('VALIDATION_ERROR');
    expect(body.message).toContain('already have');
  });

  it('returns existing checkout URL when status is created (idempotent)', async () => {
    ddbMock.on(GetCommand).resolves({
      Item: {
        userId: 'user-1',
        status: 'created',
        checkoutSessionId: 'cs_existing_456',
        checkoutUrl: 'https://checkout.stripe.com/existing',
      },
    });

    const res = await handler(makeEvent({ planId: 'price_123' })) as any;

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.data.checkoutSessionId).toBe('cs_existing_456');
    expect(body.data.checkoutUrl).toBe('https://checkout.stripe.com/existing');
    expect(body.data.status).toBe('created');
    expect(body.message).toContain('existing');
  });

  // ── Successful checkout session creation ───────────────────

  it('creates checkout session successfully and stores in DDB', async () => {
    const res = await handler(makeEvent({ planId: 'price_pro_monthly' })) as any;

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(true);
    expect(body.data.checkoutSessionId).toBe('cs_test_123');
    expect(body.data.checkoutUrl).toBe('https://checkout.stripe.com/test');
    expect(body.data.status).toBe('created');

    // Verify Stripe was called
    expect(mockSessionsCreate).toHaveBeenCalledOnce();

    // Verify DDB PutCommand was called with correct fields
    const putCalls = ddbMock.commandCalls(PutCommand);
    expect(putCalls).toHaveLength(1);
    const putInput = putCalls[0].args[0].input;
    expect(putInput.TableName).toBe('test-subscriptions');
    expect(putInput.Item).toMatchObject({
      userId: 'user-1',
      checkoutSessionId: 'cs_test_123',
      checkoutUrl: 'https://checkout.stripe.com/test',
      planId: 'price_pro_monthly',
      status: 'created',
    });
    expect(putInput.Item.createdAt).toBeDefined();
    expect(putInput.Item.updatedAt).toBeDefined();
    expect(putInput.ConditionExpression).toContain('attribute_not_exists');
  });

  // ── Race condition ─────────────────────────────────────────

  it('returns 409 on ConditionalCheckFailedException (race condition)', async () => {
    const condError = new Error('The conditional request failed');
    (condError as any).name = 'ConditionalCheckFailedException';
    ddbMock.on(PutCommand).rejects(condError);

    const res = await handler(makeEvent({ planId: 'price_123' })) as any;

    expect(res.statusCode).toBe(409);
    const body = JSON.parse(res.body);
    expect(body.errorCode).toBe('VALIDATION_ERROR');
    expect(body.message).toContain('active subscription already exists');
  });

  // ── Stripe API failure ─────────────────────────────────────

  it('returns 500 when Stripe API fails', async () => {
    mockSessionsCreate.mockRejectedValue(new Error('Stripe API error'));

    const res = await handler(makeEvent({ planId: 'price_123' })) as any;

    expect(res.statusCode).toBe(500);
    const body = JSON.parse(res.body);
    expect(body.errorCode).toBe('INTERNAL_ERROR');
    expect(body.message).toContain('Failed to create checkout session');
  });

  // ── Blocked statuses ───────────────────────────────────────

  it('returns 400 when user has trialing subscription', async () => {
    ddbMock.on(GetCommand).resolves({
      Item: { userId: 'user-1', status: 'trialing' },
    });

    const res = await handler(makeEvent({ planId: 'price_123' })) as any;

    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.message).toContain('trialing');
  });

  it('returns 400 when user has past_due subscription', async () => {
    ddbMock.on(GetCommand).resolves({
      Item: { userId: 'user-1', status: 'past_due' },
    });

    const res = await handler(makeEvent({ planId: 'price_123' })) as any;

    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.message).toContain('past_due');
  });

  it('returns 400 when user has cancellation_requested subscription', async () => {
    ddbMock.on(GetCommand).resolves({
      Item: { userId: 'user-1', status: 'cancellation_requested' },
    });

    const res = await handler(makeEvent({ planId: 'price_123' })) as any;

    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.message).toContain('cancellation_requested');
  });

  // ── Invalid JSON body ──────────────────────────────────────

  it('returns 400 when body is invalid JSON', async () => {
    const event = makeEvent({ planId: 'price_123' });
    event.body = '{not-valid-json';
    const res = await handler(event) as any;

    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.errorCode).toBe('VALIDATION_ERROR');
    expect(body.message).toContain('Invalid JSON');
  });
});
