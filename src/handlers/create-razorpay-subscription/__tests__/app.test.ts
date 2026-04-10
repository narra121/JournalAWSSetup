import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBDocumentClient, PutCommand, GetCommand } from '@aws-sdk/lib-dynamodb';
import type { APIGatewayProxyEvent } from 'aws-lambda';

// ─── Razorpay mock ─────────────────────────────────────────────
const mockSubscriptionsCreate = vi.fn();

vi.mock('razorpay', () => {
  return {
    default: vi.fn().mockImplementation(() => ({
      subscriptions: {
        create: mockSubscriptionsCreate,
      },
    })),
  };
});

// ─── Env vars (before handler import) ──────────────────────────
vi.stubEnv('RAZORPAY_KEY_ID', 'test-key-id');
vi.stubEnv('RAZORPAY_KEY_SECRET', 'test-key-secret');
vi.stubEnv('SUBSCRIPTIONS_TABLE', 'test-subscriptions');

const ddbMock = mockClient(DynamoDBDocumentClient);

const { handler } = await import('../app.ts');

// ─── Helpers ───────────────────────────────────────────────────

function makeJwt(sub: string): string {
  const header = btoa(JSON.stringify({ alg: 'RS256' }));
  const payload = btoa(JSON.stringify({ sub }));
  return `${header}.${payload}.sig`;
}

function makeEvent(
  body: any,
  overrides: Partial<APIGatewayProxyEvent> = {},
): APIGatewayProxyEvent {
  return {
    httpMethod: 'POST',
    path: '/subscriptions/razorpay',
    resource: '/subscriptions/razorpay',
    headers: {
      authorization: `Bearer ${makeJwt('user-1')}`,
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
      identity: {
        accessKey: null, accountId: null, apiKey: null, apiKeyId: null,
        caller: null, clientCert: null, cognitoAuthenticationProvider: null,
        cognitoAuthenticationType: null, cognitoIdentityId: null,
        cognitoIdentityPoolId: null, principalOrgId: null, sourceIp: '127.0.0.1',
        user: null, userAgent: 'test', userArn: null,
      },
      path: '/subscriptions/razorpay',
      stage: 'test',
      requestId: 'req-1',
      requestTimeEpoch: 0,
      resourceId: 'res-1',
      resourcePath: '/subscriptions/razorpay',
    },
    body: body !== undefined ? JSON.stringify(body) : null,
    isBase64Encoded: false,
    ...overrides,
  } as unknown as APIGatewayProxyEvent;
}

const MOCK_RAZORPAY_SUBSCRIPTION = {
  id: 'sub_RPay123',
  plan_id: 'plan_abc',
  status: 'created',
  quantity: 1,
  total_count: 120,
  paid_count: 0,
  remaining_count: 120,
  short_url: 'https://rzp.io/i/test-payment-link',
  current_start: null,
  current_end: null,
  start_at: null,
  end_at: null,
  charge_at: null,
  auth_attempts: 0,
};

// ─── Tests ─────────────────────────────────────────────────────

beforeEach(() => {
  ddbMock.reset();
  mockSubscriptionsCreate.mockReset();

  // Default: no existing subscription
  ddbMock.on(GetCommand).resolves({ Item: undefined });
  ddbMock.on(PutCommand).resolves({});

  // Default: Razorpay returns a valid subscription
  mockSubscriptionsCreate.mockResolvedValue({ ...MOCK_RAZORPAY_SUBSCRIPTION });
});

describe('create-razorpay-subscription handler', () => {
  // ── Auth errors ────────────────────────────────────────────

  it('returns 401 when authorization header is missing', async () => {
    const event = makeEvent({ planId: 'plan_abc' });
    event.headers = {};
    const res = await handler(event) as any;

    expect(res.statusCode).toBe(401);
    const body = JSON.parse(res.body);
    expect(body.errorCode).toBe('UNAUTHORIZED');
  });

  it('returns 401 when authorization header has invalid JWT', async () => {
    const event = makeEvent({ planId: 'plan_abc' });
    event.headers = { authorization: 'Bearer invalid-token' };
    const res = await handler(event) as any;

    expect(res.statusCode).toBe(401);
    const body = JSON.parse(res.body);
    expect(body.errorCode).toBe('UNAUTHORIZED');
  });

  // ── Validation errors ──────────────────────────────────────

  it('returns 400 when planId is missing', async () => {
    const res = await handler(makeEvent({})) as any;

    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.errorCode).toBe('VALIDATION_ERROR');
    expect(body.message).toContain('planId');
  });

  it('returns 400 when body is null (missing body)', async () => {
    const event = makeEvent(undefined);
    event.body = null;
    const res = await handler(event) as any;

    // JSON.parse('{}') yields empty object => planId is undefined => 400
    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.errorCode).toBe('VALIDATION_ERROR');
    expect(body.message).toContain('planId');
  });

  it('returns 500 when body is invalid JSON', async () => {
    const event = makeEvent({ planId: 'plan_abc' });
    event.body = '{not-valid-json';
    const res = await handler(event) as any;

    // JSON.parse throws, caught by outer catch => 500
    expect(res.statusCode).toBe(500);
    const body = JSON.parse(res.body);
    expect(body.errorCode).toBe('INTERNAL_ERROR');
  });

  // ── Duplicate subscription prevention ──────────────────────

  it('returns existing payment link when user has a "created" subscription', async () => {
    ddbMock.on(GetCommand).resolves({
      Item: {
        userId: 'user-1',
        subscriptionId: 'sub_existing',
        planId: 'plan_abc',
        status: 'created',
        paymentLink: 'https://rzp.io/i/existing-link',
        authAttempts: 2,
      },
    });

    const res = await handler(makeEvent({ planId: 'plan_abc' })) as any;

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(true);
    expect(body.data.subscriptionId).toBe('sub_existing');
    expect(body.data.paymentLink).toBe('https://rzp.io/i/existing-link');
    expect(body.data.authAttempts).toBe(2);
    expect(body.message).toContain('existing');
    // Should NOT call Razorpay to create a new subscription
    expect(mockSubscriptionsCreate).not.toHaveBeenCalled();
  });

  it('returns 400 when user has an "active" subscription', async () => {
    ddbMock.on(GetCommand).resolves({
      Item: {
        userId: 'user-1',
        subscriptionId: 'sub_active',
        planId: 'plan_abc',
        status: 'active',
      },
    });

    const res = await handler(makeEvent({ planId: 'plan_abc' })) as any;

    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.errorCode).toBe('VALIDATION_ERROR');
    expect(body.message).toContain('active');
    expect(mockSubscriptionsCreate).not.toHaveBeenCalled();
  });

  it('returns 400 when user has an "authenticated" subscription', async () => {
    ddbMock.on(GetCommand).resolves({
      Item: {
        userId: 'user-1',
        subscriptionId: 'sub_auth',
        planId: 'plan_abc',
        status: 'authenticated',
      },
    });

    const res = await handler(makeEvent({ planId: 'plan_abc' })) as any;

    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.errorCode).toBe('VALIDATION_ERROR');
    expect(body.message).toContain('authenticated');
    expect(mockSubscriptionsCreate).not.toHaveBeenCalled();
  });

  it('returns 400 when user has a "cancellation_requested" subscription', async () => {
    ddbMock.on(GetCommand).resolves({
      Item: {
        userId: 'user-1',
        subscriptionId: 'sub_cancel',
        planId: 'plan_abc',
        status: 'cancellation_requested',
      },
    });

    const res = await handler(makeEvent({ planId: 'plan_abc' })) as any;

    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.errorCode).toBe('VALIDATION_ERROR');
    expect(body.message).toContain('cancellation_requested');
    expect(mockSubscriptionsCreate).not.toHaveBeenCalled();
  });

  it('allows creating subscription when user has a "cancelled" subscription', async () => {
    ddbMock.on(GetCommand).resolves({
      Item: {
        userId: 'user-1',
        subscriptionId: 'sub_old',
        planId: 'plan_old',
        status: 'cancelled',
      },
    });

    const res = await handler(makeEvent({ planId: 'plan_abc' })) as any;

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(true);
    expect(body.data.subscriptionId).toBe('sub_RPay123');
    expect(mockSubscriptionsCreate).toHaveBeenCalled();
  });

  // ── Success: creates subscription ──────────────────────────

  it('creates a subscription and returns 200 with payment link', async () => {
    const res = await handler(makeEvent({ planId: 'plan_abc' })) as any;

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(true);
    expect(body.data.subscriptionId).toBe('sub_RPay123');
    expect(body.data.planId).toBe('plan_abc');
    expect(body.data.status).toBe('created');
    expect(body.data.shortUrl).toBe('https://rzp.io/i/test-payment-link');
    expect(body.data.paymentLink).toBe('https://rzp.io/i/test-payment-link');
    expect(body.message).toContain('Subscription created');
  });

  it('passes planId and defaults to Razorpay correctly', async () => {
    await handler(makeEvent({ planId: 'plan_xyz' })) as any;

    expect(mockSubscriptionsCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        plan_id: 'plan_xyz',
        quantity: 1,
        customer_notify: 1,
        total_count: 120,
        notes: expect.objectContaining({ userId: 'user-1' }),
      }),
    );
  });

  it('passes custom totalCount, quantity, and startAt', async () => {
    await handler(makeEvent({
      planId: 'plan_abc',
      totalCount: 24,
      quantity: 2,
      startAt: 1700000000,
      customerNotify: 0,
      notes: { campaign: 'test-campaign' },
    })) as any;

    expect(mockSubscriptionsCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        plan_id: 'plan_abc',
        quantity: 2,
        customer_notify: 0,
        total_count: 24,
        start_at: 1700000000,
        notes: expect.objectContaining({
          userId: 'user-1',
          campaign: 'test-campaign',
        }),
      }),
    );
  });

  it('removes total_count when totalCount is explicitly null', async () => {
    await handler(makeEvent({
      planId: 'plan_abc',
      totalCount: null,
    })) as any;

    const call = mockSubscriptionsCreate.mock.calls[0][0];
    expect(call).not.toHaveProperty('total_count');
  });

  it('removes total_count when totalCount is 0', async () => {
    await handler(makeEvent({
      planId: 'plan_abc',
      totalCount: 0,
    })) as any;

    const call = mockSubscriptionsCreate.mock.calls[0][0];
    expect(call).not.toHaveProperty('total_count');
  });

  it('stores subscription record in DynamoDB on success', async () => {
    await handler(makeEvent({ planId: 'plan_abc' })) as any;

    const putCalls = ddbMock.commandCalls(PutCommand);
    expect(putCalls).toHaveLength(1);
    expect(putCalls[0].args[0].input.TableName).toBe('test-subscriptions');

    const item = putCalls[0].args[0].input.Item;
    expect(item).toMatchObject({
      userId: 'user-1',
      subscriptionId: 'sub_RPay123',
      planId: 'plan_abc',
      status: 'created',
      quantity: 1,
      paidCount: 0,
      paymentLink: 'https://rzp.io/i/test-payment-link',
    });
    expect(item!.createdAt).toBeDefined();
    expect(item!.updatedAt).toBeDefined();
  });

  // ── Razorpay API failure ───────────────────────────────────

  it('returns 500 when Razorpay subscription creation fails', async () => {
    mockSubscriptionsCreate.mockRejectedValueOnce(new Error('Razorpay API error'));

    const res = await handler(makeEvent({ planId: 'plan_abc' })) as any;

    expect(res.statusCode).toBe(500);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(false);
    expect(body.errorCode).toBe('INTERNAL_ERROR');
  });

  it('returns 500 when Razorpay rejects with invalid plan ID', async () => {
    mockSubscriptionsCreate.mockRejectedValueOnce(
      Object.assign(new Error('The id provided does not exist'), {
        statusCode: 400,
        error: { description: 'The id provided does not exist' },
      }),
    );

    const res = await handler(makeEvent({ planId: 'plan_invalid' })) as any;

    expect(res.statusCode).toBe(500);
    const body = JSON.parse(res.body);
    expect(body.errorCode).toBe('INTERNAL_ERROR');
  });

  // ── DynamoDB failures ──────────────────────────────────────

  it('returns 500 when DynamoDB GetCommand fails (checking existing)', async () => {
    ddbMock.on(GetCommand).rejects(new Error('DynamoDB read error'));

    const res = await handler(makeEvent({ planId: 'plan_abc' })) as any;

    expect(res.statusCode).toBe(500);
    const body = JSON.parse(res.body);
    expect(body.errorCode).toBe('INTERNAL_ERROR');
  });

  it('returns 500 when DynamoDB PutCommand fails (storing subscription)', async () => {
    ddbMock.on(PutCommand).rejects(new Error('DynamoDB write error'));

    const res = await handler(makeEvent({ planId: 'plan_abc' })) as any;

    expect(res.statusCode).toBe(500);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(false);
    expect(body.errorCode).toBe('INTERNAL_ERROR');
  });

  // ── Edge cases ─────────────────────────────────────────────

  it('does not call Razorpay when user is unauthorized', async () => {
    const event = makeEvent({ planId: 'plan_abc' });
    event.headers = {};
    await handler(event) as any;

    expect(mockSubscriptionsCreate).not.toHaveBeenCalled();
  });

  it('does not call Razorpay when planId validation fails', async () => {
    await handler(makeEvent({})) as any;

    expect(mockSubscriptionsCreate).not.toHaveBeenCalled();
  });
});
