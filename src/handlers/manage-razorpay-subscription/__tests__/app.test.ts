import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBDocumentClient, GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import type { APIGatewayProxyEvent } from 'aws-lambda';

// ─── Razorpay mock ─────────────────────────────────────────────
const mockSubscriptionsFetch = vi.fn();
const mockSubscriptionsAll = vi.fn();
const mockSubscriptionsPause = vi.fn();
const mockSubscriptionsResume = vi.fn();
const mockSubscriptionsCancel = vi.fn();

vi.mock('razorpay', () => {
  return {
    default: vi.fn().mockImplementation(() => ({
      subscriptions: {
        fetch: mockSubscriptionsFetch,
        all: mockSubscriptionsAll,
        pause: mockSubscriptionsPause,
        resume: mockSubscriptionsResume,
        cancel: mockSubscriptionsCancel,
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
  method: string,
  body: any = undefined,
  overrides: Partial<APIGatewayProxyEvent> = {},
): APIGatewayProxyEvent {
  return {
    httpMethod: method,
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
      httpMethod: method,
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

const DB_SUBSCRIPTION = {
  userId: 'user-1',
  subscriptionId: 'sub_RPay123',
  planId: 'plan_abc',
  status: 'active',
  paidCount: 3,
  remainingCount: 117,
  createdAt: '2025-01-01T00:00:00.000Z',
  updatedAt: '2025-03-01T00:00:00.000Z',
};

const RAZORPAY_SUBSCRIPTION = {
  id: 'sub_RPay123',
  plan_id: 'plan_abc',
  status: 'active',
  quantity: 1,
  total_count: 120,
  paid_count: 3,
  remaining_count: 117,
  short_url: 'https://rzp.io/i/test',
  current_start: 1704067200, // 2024-01-01
  current_end: 1706745600,   // 2024-02-01
  charge_at: 1706745600,
  start_at: 1704067200,
  end_at: null,
  ended_at: null,
  auth_attempts: 1,
  notes: { userId: 'user-1' },
};

// ─── Tests ─────────────────────────────────────────────────────

beforeEach(() => {
  ddbMock.reset();
  mockSubscriptionsFetch.mockReset();
  mockSubscriptionsAll.mockReset();
  mockSubscriptionsPause.mockReset();
  mockSubscriptionsResume.mockReset();
  mockSubscriptionsCancel.mockReset();

  // Default DDB responses
  ddbMock.on(GetCommand).resolves({ Item: { ...DB_SUBSCRIPTION } });
  ddbMock.on(UpdateCommand).resolves({});

  // Default Razorpay responses
  mockSubscriptionsFetch.mockResolvedValue({ ...RAZORPAY_SUBSCRIPTION });
  mockSubscriptionsAll.mockResolvedValue({ items: [{ ...RAZORPAY_SUBSCRIPTION }] });
  mockSubscriptionsPause.mockResolvedValue({});
  mockSubscriptionsResume.mockResolvedValue({});
  mockSubscriptionsCancel.mockResolvedValue({});
});

// ════════════════════════════════════════════════════════════════
// Auth errors — all methods
// ════════════════════════════════════════════════════════════════

describe('auth errors', () => {
  for (const method of ['GET', 'PUT', 'DELETE', 'PATCH']) {
    it(`returns 401 for ${method} when authorization is missing`, async () => {
      const event = makeEvent(method, method === 'GET' ? undefined : { action: 'pause' });
      event.headers = {};
      const res = await handler(event) as any;

      expect(res.statusCode).toBe(401);
      const body = JSON.parse(res.body);
      expect(body.errorCode).toBe('UNAUTHORIZED');
    });
  }
});

// ════════════════════════════════════════════════════════════════
// Method not allowed
// ════════════════════════════════════════════════════════════════

describe('method not allowed', () => {
  it('returns 405 for POST method', async () => {
    const res = await handler(makeEvent('POST', { action: 'something' })) as any;

    expect(res.statusCode).toBe(405);
    const body = JSON.parse(res.body);
    expect(body.errorCode).toBe('VALIDATION_ERROR');
    expect(body.message).toContain('Method not allowed');
  });
});

// ════════════════════════════════════════════════════════════════
// GET: Fetch subscription details
// ════════════════════════════════════════════════════════════════

describe('GET - fetch subscription details', () => {
  it('returns 200 with merged subscription data from DDB and Razorpay', async () => {
    const res = await handler(makeEvent('GET')) as any;

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(true);
    expect(body.data.subscriptionId).toBe('sub_RPay123');
    expect(body.data.planId).toBe('plan_abc');
    expect(body.data.status).toBe('active');
    expect(body.data.paidCount).toBe(3);
    expect(body.data.paymentLink).toBe('https://rzp.io/i/test');
    expect(body.data.razorpayDetails).toBeDefined();
    expect(body.data.razorpayDetails.status).toBe('active');
  });

  it('returns 404 when no subscription found in DDB', async () => {
    ddbMock.on(GetCommand).resolves({ Item: undefined });

    const res = await handler(makeEvent('GET')) as any;

    expect(res.statusCode).toBe(404);
    const body = JSON.parse(res.body);
    expect(body.errorCode).toContain('NOT_FOUND');
  });

  it('returns DB data when Razorpay fetch fails (graceful degradation)', async () => {
    mockSubscriptionsFetch.mockRejectedValueOnce(new Error('Razorpay API error'));

    const res = await handler(makeEvent('GET')) as any;

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.data.subscriptionId).toBe('sub_RPay123');
    // Should return raw DB item when Razorpay fails
    expect(body.data.status).toBe('active');
  });

  it('preserves cancellation_requested status when Razorpay shows active', async () => {
    ddbMock.on(GetCommand).resolves({
      Item: { ...DB_SUBSCRIPTION, status: 'cancellation_requested' },
    });
    mockSubscriptionsFetch.mockResolvedValueOnce({
      ...RAZORPAY_SUBSCRIPTION,
      status: 'active',
    });
    mockSubscriptionsAll.mockResolvedValueOnce({
      items: [{ ...RAZORPAY_SUBSCRIPTION, status: 'active' }],
    });

    const res = await handler(makeEvent('GET')) as any;

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.data.status).toBe('cancellation_requested');
    expect(body.data.razorpayDetails.status).toBe('active');
  });

  it('updates DDB when Razorpay has a newer subscription', async () => {
    mockSubscriptionsAll.mockResolvedValueOnce({
      items: [
        {
          ...RAZORPAY_SUBSCRIPTION,
          id: 'sub_RPay999',
          status: 'active',
          notes: { userId: 'user-1' },
        },
        { ...RAZORPAY_SUBSCRIPTION, notes: { userId: 'user-1' } },
      ],
    });

    const res = await handler(makeEvent('GET')) as any;

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.data.subscriptionId).toBe('sub_RPay999');

    // Verify DDB was updated
    const updateCalls = ddbMock.commandCalls(UpdateCommand);
    expect(updateCalls.length).toBeGreaterThanOrEqual(1);
  });

  it('handles DDB item with no subscriptionId gracefully', async () => {
    ddbMock.on(GetCommand).resolves({
      Item: { userId: 'user-1', status: 'created' },
    });

    const res = await handler(makeEvent('GET')) as any;

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    // Should return raw DB item since subscriptionId is falsy
    expect(body.data.userId).toBe('user-1');
  });

  it('handles Razorpay subscriptions.all failure gracefully', async () => {
    mockSubscriptionsAll.mockRejectedValueOnce(new Error('API limit exceeded'));

    const res = await handler(makeEvent('GET')) as any;

    // Should still succeed, using the single fetch result
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.data.subscriptionId).toBe('sub_RPay123');
  });
});

// ════════════════════════════════════════════════════════════════
// PUT: Pause / Resume subscription
// ════════════════════════════════════════════════════════════════

describe('PUT - pause/resume subscription', () => {
  // ── Pause ──────────────────────────────────────────────────

  it('pauses subscription successfully', async () => {
    const res = await handler(makeEvent('PUT', { action: 'pause' })) as any;

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.data.message).toContain('paused');
    expect(body.data.subscriptionId).toBe('sub_RPay123');

    expect(mockSubscriptionsPause).toHaveBeenCalledWith('sub_RPay123', { pause_at: 'now' });

    // Verify DDB status updated to 'paused'
    const updateCalls = ddbMock.commandCalls(UpdateCommand);
    expect(updateCalls).toHaveLength(1);
    expect(updateCalls[0].args[0].input.ExpressionAttributeValues).toMatchObject({
      ':status': 'paused',
    });
  });

  it('passes custom pauseAt when provided', async () => {
    await handler(makeEvent('PUT', { action: 'pause', pauseAt: 1700000000 })) as any;

    expect(mockSubscriptionsPause).toHaveBeenCalledWith('sub_RPay123', {
      pause_at: 1700000000,
    });
  });

  // ── Resume ─────────────────────────────────────────────────

  it('resumes subscription successfully', async () => {
    ddbMock.on(GetCommand).resolves({
      Item: { ...DB_SUBSCRIPTION, status: 'paused' },
    });

    const res = await handler(makeEvent('PUT', { action: 'resume' })) as any;

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.data.message).toContain('resumed');
    expect(body.data.subscriptionId).toBe('sub_RPay123');

    expect(mockSubscriptionsResume).toHaveBeenCalledWith('sub_RPay123', { resume_at: 'now' });

    // Verify DDB status updated to 'active'
    const updateCalls = ddbMock.commandCalls(UpdateCommand);
    expect(updateCalls).toHaveLength(1);
    expect(updateCalls[0].args[0].input.ExpressionAttributeValues).toMatchObject({
      ':status': 'active',
    });
  });

  it('passes custom resumeAt when provided', async () => {
    await handler(makeEvent('PUT', { action: 'resume', resumeAt: 1700000000 })) as any;

    expect(mockSubscriptionsResume).toHaveBeenCalledWith('sub_RPay123', {
      resume_at: 1700000000,
    });
  });

  // ── Validation ─────────────────────────────────────────────

  it('returns 400 when action is invalid', async () => {
    const res = await handler(makeEvent('PUT', { action: 'upgrade' })) as any;

    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.errorCode).toBe('VALIDATION_ERROR');
    expect(body.message).toContain('pause');
  });

  it('returns 400 when action is missing', async () => {
    const res = await handler(makeEvent('PUT', {})) as any;

    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.errorCode).toBe('VALIDATION_ERROR');
  });

  it('returns 404 when no subscription found for pause', async () => {
    ddbMock.on(GetCommand).resolves({ Item: undefined });

    const res = await handler(makeEvent('PUT', { action: 'pause' })) as any;

    expect(res.statusCode).toBe(404);
    const body = JSON.parse(res.body);
    expect(body.errorCode).toContain('NOT_FOUND');
  });

  it('returns 404 when subscription has no subscriptionId for resume', async () => {
    ddbMock.on(GetCommand).resolves({
      Item: { userId: 'user-1', status: 'active' },
    });

    const res = await handler(makeEvent('PUT', { action: 'resume' })) as any;

    expect(res.statusCode).toBe(404);
  });

  // ── Razorpay failures ──────────────────────────────────────

  it('returns 500 when Razorpay pause API fails', async () => {
    mockSubscriptionsPause.mockRejectedValueOnce(new Error('Razorpay pause failed'));

    const res = await handler(makeEvent('PUT', { action: 'pause' })) as any;

    expect(res.statusCode).toBe(500);
    const body = JSON.parse(res.body);
    expect(body.errorCode).toBe('INTERNAL_ERROR');
  });

  it('returns 500 when Razorpay resume API fails', async () => {
    mockSubscriptionsResume.mockRejectedValueOnce(new Error('Razorpay resume failed'));

    const res = await handler(makeEvent('PUT', { action: 'resume' })) as any;

    expect(res.statusCode).toBe(500);
    const body = JSON.parse(res.body);
    expect(body.errorCode).toBe('INTERNAL_ERROR');
  });

  // ── DDB failure after Razorpay call ────────────────────────

  it('returns 500 when DDB update fails after successful Razorpay pause', async () => {
    ddbMock.on(UpdateCommand).rejects(new Error('DDB write failed'));

    const res = await handler(makeEvent('PUT', { action: 'pause' })) as any;

    expect(res.statusCode).toBe(500);
    const body = JSON.parse(res.body);
    expect(body.errorCode).toBe('INTERNAL_ERROR');
    // Razorpay was still called
    expect(mockSubscriptionsPause).toHaveBeenCalled();
  });
});

// ════════════════════════════════════════════════════════════════
// PATCH: Undo cancellation
// ════════════════════════════════════════════════════════════════

describe('PATCH - undo cancellation', () => {
  it('undoes cancellation successfully when subscription is cancellation_requested and Razorpay is active', async () => {
    ddbMock.on(GetCommand).resolves({
      Item: { ...DB_SUBSCRIPTION, status: 'cancellation_requested' },
    });
    mockSubscriptionsFetch.mockResolvedValueOnce({
      ...RAZORPAY_SUBSCRIPTION,
      status: 'active',
    });

    const res = await handler(makeEvent('PATCH', { action: 'undo_cancellation' })) as any;

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.data.status).toBe('active');
    expect(body.data.message).toContain('Cancellation undone');

    // Verify DDB updated to active and cancelAt removed
    const updateCalls = ddbMock.commandCalls(UpdateCommand);
    expect(updateCalls).toHaveLength(1);
    expect(updateCalls[0].args[0].input.UpdateExpression).toContain('REMOVE cancelAt');
    expect(updateCalls[0].args[0].input.ExpressionAttributeValues).toMatchObject({
      ':status': 'active',
    });
  });

  it('returns 400 when action is not undo_cancellation', async () => {
    const res = await handler(makeEvent('PATCH', { action: 'something_else' })) as any;

    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.errorCode).toBe('VALIDATION_ERROR');
    expect(body.message).toContain('undo_cancellation');
  });

  it('returns 404 when no subscription found', async () => {
    ddbMock.on(GetCommand).resolves({ Item: undefined });

    const res = await handler(makeEvent('PATCH', { action: 'undo_cancellation' })) as any;

    expect(res.statusCode).toBe(404);
  });

  it('returns 400 when subscription is not in cancellation_requested status', async () => {
    ddbMock.on(GetCommand).resolves({
      Item: { ...DB_SUBSCRIPTION, status: 'active' },
    });

    const res = await handler(makeEvent('PATCH', { action: 'undo_cancellation' })) as any;

    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.errorCode).toBe('VALIDATION_ERROR');
    expect(body.message).toContain('not scheduled for cancellation');
  });

  it('returns 400 when Razorpay subscription is no longer active', async () => {
    ddbMock.on(GetCommand).resolves({
      Item: { ...DB_SUBSCRIPTION, status: 'cancellation_requested' },
    });
    mockSubscriptionsFetch.mockResolvedValueOnce({
      ...RAZORPAY_SUBSCRIPTION,
      status: 'cancelled',
    });

    const res = await handler(makeEvent('PATCH', { action: 'undo_cancellation' })) as any;

    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.errorCode).toBe('VALIDATION_ERROR');
    expect(body.message).toContain('no longer active');
  });

  it('returns 500 when Razorpay fetch fails during undo cancellation', async () => {
    ddbMock.on(GetCommand).resolves({
      Item: { ...DB_SUBSCRIPTION, status: 'cancellation_requested' },
    });
    mockSubscriptionsFetch.mockRejectedValueOnce(new Error('Razorpay fetch failed'));

    const res = await handler(makeEvent('PATCH', { action: 'undo_cancellation' })) as any;

    expect(res.statusCode).toBe(500);
    const body = JSON.parse(res.body);
    expect(body.errorCode).toBe('INTERNAL_ERROR');
  });

  it('returns 500 when DDB update fails after successful undo', async () => {
    ddbMock.on(GetCommand).resolves({
      Item: { ...DB_SUBSCRIPTION, status: 'cancellation_requested' },
    });
    mockSubscriptionsFetch.mockResolvedValueOnce({
      ...RAZORPAY_SUBSCRIPTION,
      status: 'active',
    });
    ddbMock.on(UpdateCommand).rejects(new Error('DDB write failed'));

    const res = await handler(makeEvent('PATCH', { action: 'undo_cancellation' })) as any;

    expect(res.statusCode).toBe(500);
    const body = JSON.parse(res.body);
    expect(body.errorCode).toBe('INTERNAL_ERROR');
  });
});

// ════════════════════════════════════════════════════════════════
// DELETE: Cancel subscription
// ════════════════════════════════════════════════════════════════

describe('DELETE - cancel subscription', () => {
  it('cancels subscription immediately (default)', async () => {
    const res = await handler(makeEvent('DELETE', {})) as any;

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.data.status).toBe('cancelled');
    expect(body.data.message).toContain('cancelled immediately');
    expect(body.data.subscriptionId).toBe('sub_RPay123');

    expect(mockSubscriptionsCancel).toHaveBeenCalledWith('sub_RPay123');

    // Verify DDB status updated to 'cancelled'
    const updateCalls = ddbMock.commandCalls(UpdateCommand);
    expect(updateCalls).toHaveLength(1);
    expect(updateCalls[0].args[0].input.ExpressionAttributeValues).toMatchObject({
      ':status': 'cancelled',
      ':cancelAt': 'immediate',
    });
  });

  it('cancels at cycle end when cancelAtCycleEnd is true', async () => {
    const res = await handler(makeEvent('DELETE', { cancelAtCycleEnd: true })) as any;

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.data.status).toBe('cancellation_requested');
    expect(body.data.message).toContain('end of the current billing period');

    expect(mockSubscriptionsCancel).toHaveBeenCalledWith('sub_RPay123', {
      cancel_at_cycle_end: 1,
    });

    const updateCalls = ddbMock.commandCalls(UpdateCommand);
    expect(updateCalls[0].args[0].input.ExpressionAttributeValues).toMatchObject({
      ':status': 'cancellation_requested',
      ':cancelAt': 'cycle_end',
    });
  });

  it('returns 404 when no subscription found', async () => {
    ddbMock.on(GetCommand).resolves({ Item: undefined });

    const res = await handler(makeEvent('DELETE', {})) as any;

    expect(res.statusCode).toBe(404);
    const body = JSON.parse(res.body);
    expect(body.errorCode).toContain('NOT_FOUND');
  });

  it('returns 400 when subscription is already scheduled for cancellation', async () => {
    ddbMock.on(GetCommand).resolves({
      Item: { ...DB_SUBSCRIPTION, status: 'cancellation_requested' },
    });

    const res = await handler(makeEvent('DELETE', {})) as any;

    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.errorCode).toBe('VALIDATION_ERROR');
    expect(body.message).toContain('already scheduled');
    expect(mockSubscriptionsCancel).not.toHaveBeenCalled();
  });

  it('returns 400 when subscription is already cancelled', async () => {
    ddbMock.on(GetCommand).resolves({
      Item: { ...DB_SUBSCRIPTION, status: 'cancelled' },
    });

    const res = await handler(makeEvent('DELETE', {})) as any;

    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.errorCode).toBe('VALIDATION_ERROR');
    expect(body.message).toContain('already cancelled');
    expect(mockSubscriptionsCancel).not.toHaveBeenCalled();
  });

  it('returns 400 when subscription status is "created" (pending payment)', async () => {
    ddbMock.on(GetCommand).resolves({
      Item: { ...DB_SUBSCRIPTION, status: 'created' },
    });

    const res = await handler(makeEvent('DELETE', {})) as any;

    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.errorCode).toBe('VALIDATION_ERROR');
    expect(body.message).toContain('not started billing');
    expect(mockSubscriptionsCancel).not.toHaveBeenCalled();
  });

  it('returns 400 when Razorpay cancel returns 400 with description', async () => {
    mockSubscriptionsCancel.mockRejectedValueOnce(
      Object.assign(new Error('Bad request'), {
        statusCode: 400,
        error: { description: 'Subscription is already cancelled' },
      }),
    );

    const res = await handler(makeEvent('DELETE', {})) as any;

    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.errorCode).toBe('VALIDATION_ERROR');
    expect(body.message).toContain('Subscription is already cancelled');
  });

  it('returns 500 when Razorpay cancel throws a generic error', async () => {
    mockSubscriptionsCancel.mockRejectedValueOnce(new Error('Razorpay server error'));

    const res = await handler(makeEvent('DELETE', {})) as any;

    expect(res.statusCode).toBe(500);
    const body = JSON.parse(res.body);
    expect(body.errorCode).toBe('INTERNAL_ERROR');
  });

  it('returns 500 when DDB update fails after Razorpay cancel', async () => {
    ddbMock.on(UpdateCommand).rejects(new Error('DDB write failed'));

    const res = await handler(makeEvent('DELETE', {})) as any;

    expect(res.statusCode).toBe(500);
    const body = JSON.parse(res.body);
    expect(body.errorCode).toBe('INTERNAL_ERROR');
    // Razorpay cancel was still called
    expect(mockSubscriptionsCancel).toHaveBeenCalled();
  });

  it('returns 404 when subscription has no subscriptionId', async () => {
    ddbMock.on(GetCommand).resolves({
      Item: { userId: 'user-1', status: 'active' },
    });

    const res = await handler(makeEvent('DELETE', {})) as any;

    expect(res.statusCode).toBe(404);
  });

  it('handles null body for DELETE (defaults cancelAtCycleEnd to false)', async () => {
    const event = makeEvent('DELETE');
    event.body = null;

    const res = await handler(event) as any;

    // JSON.parse('{}') => {} => cancelAtCycleEnd defaults to false
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.data.status).toBe('cancelled');
    expect(mockSubscriptionsCancel).toHaveBeenCalledWith('sub_RPay123');
  });
});

// ════════════════════════════════════════════════════════════════
// Edge cases
// ════════════════════════════════════════════════════════════════

describe('edge cases', () => {
  it('returns 500 when DDB GetCommand fails (any method)', async () => {
    ddbMock.on(GetCommand).rejects(new Error('DDB connection error'));

    const res = await handler(makeEvent('GET')) as any;

    expect(res.statusCode).toBe(500);
    const body = JSON.parse(res.body);
    expect(body.errorCode).toBe('INTERNAL_ERROR');
  });

  it('handles invalid JSON body for PUT gracefully', async () => {
    const event = makeEvent('PUT');
    event.body = '{invalid-json';

    const res = await handler(event) as any;

    // JSON.parse throws => caught by outer catch
    expect(res.statusCode).toBe(500);
    const body = JSON.parse(res.body);
    expect(body.errorCode).toBe('INTERNAL_ERROR');
  });

  it('handles invalid JSON body for DELETE gracefully', async () => {
    const event = makeEvent('DELETE');
    event.body = '{invalid-json';

    const res = await handler(event) as any;

    expect(res.statusCode).toBe(500);
    const body = JSON.parse(res.body);
    expect(body.errorCode).toBe('INTERNAL_ERROR');
  });

  it('handles invalid JSON body for PATCH gracefully', async () => {
    const event = makeEvent('PATCH');
    event.body = '{invalid-json';

    const res = await handler(event) as any;

    expect(res.statusCode).toBe(500);
    const body = JSON.parse(res.body);
    expect(body.errorCode).toBe('INTERNAL_ERROR');
  });
});
