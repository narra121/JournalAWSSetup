import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBDocumentClient, GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';
import type { APIGatewayProxyEventV2 } from 'aws-lambda';

// Mock environment variables before importing handler
vi.stubEnv('SUBSCRIPTIONS_TABLE', 'test-subscriptions');
vi.stubEnv('STRIPE_SECRET_KEY_PARAM', '/test/stripeSecretKey');

// ─── Mock Stripe ─────────────────────────────────────────────────

const mockSubscriptionsRetrieve = vi.fn();
const mockSubscriptionsUpdate = vi.fn();
const mockSubscriptionsCancel = vi.fn();

vi.mock('stripe', () => {
  return {
    default: class StripeMock {
      subscriptions = {
        retrieve: mockSubscriptionsRetrieve,
        update: mockSubscriptionsUpdate,
        cancel: mockSubscriptionsCancel,
      };
    },
  };
});

// ─── Mock AWS clients ────────────────────────────────────────────

const ddbMock = mockClient(DynamoDBDocumentClient);
const ssmMock = mockClient(SSMClient);

const { handler } = await import('../app.ts');

// ─── Helpers ─────────────────────────────────────────────────────

function makeJwt(sub: string): string {
  const header = btoa(JSON.stringify({ alg: 'RS256' }));
  const payload = btoa(JSON.stringify({ sub }));
  return `${header}.${payload}.sig`;
}

function makeEvent(
  method: string,
  body?: any,
  overrides: Partial<APIGatewayProxyEventV2> = {},
): APIGatewayProxyEventV2 {
  return {
    version: '2.0',
    routeKey: `${method} /subscriptions`,
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
      http: { method, path: '/subscriptions', protocol: 'HTTP/1.1', sourceIp: '127.0.0.1', userAgent: 'test' },
      requestId: 'req-1',
      routeKey: `${method} /subscriptions`,
      stage: '$default',
      time: '01/Jan/2024:00:00:00 +0000',
      timeEpoch: 0,
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
    isBase64Encoded: false,
    ...overrides,
  } as unknown as APIGatewayProxyEventV2;
}

const activeSubscription = {
  userId: 'user-1',
  status: 'active',
  stripeSubscriptionId: 'sub_test123',
  stripeCustomerId: 'cus_test123',
  planId: 'price_monthly',
  createdAt: '2024-12-01T00:00:00.000Z',
  updatedAt: '2024-12-01T00:00:00.000Z',
};

const trialSubscription = {
  userId: 'user-1',
  status: 'trial',
  trialEnd: new Date(Date.now() + 86400000 * 7).toISOString(), // 7 days from now
  createdAt: '2024-12-01T00:00:00.000Z',
  updatedAt: '2024-12-01T00:00:00.000Z',
};

const cancellationRequestedSubscription = {
  ...activeSubscription,
  status: 'cancellation_requested',
};

function makeStripeSubscription(overrides: Record<string, any> = {}): any {
  return {
    id: 'sub_test123',
    status: 'active',
    cancel_at_period_end: false,
    cancel_at: null,
    canceled_at: null,
    current_period_start: Math.floor(Date.now() / 1000) - 86400 * 15,
    current_period_end: Math.floor(Date.now() / 1000) + 86400 * 15,
    trial_end: null,
    pause_collection: null,
    ...overrides,
  };
}

// ─── Tests ───────────────────────────────────────────────────────

beforeEach(() => {
  ddbMock.reset();
  ssmMock.reset();
  mockSubscriptionsRetrieve.mockReset();
  mockSubscriptionsUpdate.mockReset();
  mockSubscriptionsCancel.mockReset();

  // SSM returns a fake Stripe key (needed to initialize Stripe client)
  ssmMock.on(GetParameterCommand).resolves({
    Parameter: { Value: 'sk_test_fake_key' },
  });
});

describe('manage-stripe-subscription handler', () => {
  // ── 1. GET — returns 401 without auth ─────────────────────────

  it('returns 401 without auth', async () => {
    const event = makeEvent('GET', undefined, { headers: {} });
    const res = await handler(event) as any;

    expect(res.statusCode).toBe(401);
    const body = JSON.parse(res.body);
    expect(body.errorCode).toBe('UNAUTHORIZED');
  });

  // ── 2. GET — returns subscription from DDB when no stripeSubscriptionId ──

  it('GET returns subscription from DDB when no stripeSubscriptionId', async () => {
    const subWithoutStripe = {
      userId: 'user-1',
      status: 'active',
      createdAt: '2024-12-01T00:00:00.000Z',
    };
    ddbMock.on(GetCommand).resolves({ Item: subWithoutStripe });

    const res = await handler(makeEvent('GET')) as any;

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(true);
    expect(body.data.subscription).toEqual(subWithoutStripe);
    expect(mockSubscriptionsRetrieve).not.toHaveBeenCalled();
  });

  // ── 3. GET — fetches from Stripe and syncs status when stripeSubscriptionId exists ──

  it('GET fetches from Stripe and syncs status when stripeSubscriptionId exists', async () => {
    ddbMock.on(GetCommand).resolves({ Item: activeSubscription });
    ddbMock.on(UpdateCommand).resolves({});
    mockSubscriptionsRetrieve.mockResolvedValue(makeStripeSubscription());

    const res = await handler(makeEvent('GET')) as any;

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(true);
    expect(body.data.subscription.stripeDetails).toBeDefined();
    expect(body.data.subscription.stripeDetails.status).toBe('active');
    expect(mockSubscriptionsRetrieve).toHaveBeenCalledWith('sub_test123');
  });

  // ── 4. GET — returns trial info when status='trial' with trialEnd ──

  it('GET returns trial info when status=trial with trialEnd', async () => {
    const trialEndTs = Math.floor(Date.now() / 1000) + 86400 * 7;
    ddbMock.on(GetCommand).resolves({ Item: { ...trialSubscription, stripeSubscriptionId: 'sub_trial' } });
    mockSubscriptionsRetrieve.mockResolvedValue(makeStripeSubscription({
      id: 'sub_trial',
      status: 'trialing',
      trial_end: trialEndTs,
    }));
    ddbMock.on(UpdateCommand).resolves({});

    const res = await handler(makeEvent('GET')) as any;

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.data.subscription.trialEnd).toBeDefined();
    expect(body.data.subscription.stripeDetails.trialEnd).toBe(trialEndTs);
  });

  // ── 5. PUT pause — calls stripe.subscriptions.update with pause_collection ──

  it('PUT pause calls stripe.subscriptions.update with pause_collection and updates DDB', async () => {
    ddbMock.on(GetCommand).resolves({ Item: activeSubscription });
    ddbMock.on(UpdateCommand).resolves({});
    mockSubscriptionsUpdate.mockResolvedValue(makeStripeSubscription({ pause_collection: { behavior: 'void' } }));

    const res = await handler(makeEvent('PUT', { action: 'pause' })) as any;

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.data.status).toBe('paused');
    expect(body.data.message).toContain('paused');
    expect(mockSubscriptionsUpdate).toHaveBeenCalledWith('sub_test123', {
      pause_collection: { behavior: 'void' },
    });
  });

  // ── 6. PUT resume — clears pause_collection, updates DDB status='active' ──

  it('PUT resume clears pause_collection and updates DDB status to active', async () => {
    const pausedSub = { ...activeSubscription, status: 'paused' };
    ddbMock.on(GetCommand).resolves({ Item: pausedSub });
    ddbMock.on(UpdateCommand).resolves({});
    mockSubscriptionsUpdate.mockResolvedValue(makeStripeSubscription());

    const res = await handler(makeEvent('PUT', { action: 'resume' })) as any;

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.data.status).toBe('active');
    expect(body.data.message).toContain('resumed');
    expect(mockSubscriptionsUpdate).toHaveBeenCalledWith('sub_test123', {
      pause_collection: null,
    });
  });

  // ── 7. DELETE — cancel at cycle end, sets status='cancellation_requested' ──

  it('DELETE at cycle end sets status to cancellation_requested', async () => {
    ddbMock.on(GetCommand).resolves({ Item: activeSubscription });
    ddbMock.on(UpdateCommand).resolves({});
    mockSubscriptionsUpdate.mockResolvedValue(makeStripeSubscription({ cancel_at_period_end: true }));

    const res = await handler(makeEvent('DELETE', { cancelAtCycleEnd: true })) as any;

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.data.status).toBe('cancellation_requested');
    expect(mockSubscriptionsUpdate).toHaveBeenCalledWith('sub_test123', {
      cancel_at_period_end: true,
    });
    expect(mockSubscriptionsCancel).not.toHaveBeenCalled();
  });

  // ── 8. DELETE — immediate cancel, sets status='cancelled' ──

  it('DELETE immediate cancel sets status to cancelled', async () => {
    ddbMock.on(GetCommand).resolves({ Item: activeSubscription });
    ddbMock.on(UpdateCommand).resolves({});
    mockSubscriptionsCancel.mockResolvedValue(makeStripeSubscription({ status: 'canceled' }));

    const res = await handler(makeEvent('DELETE', { cancelAtCycleEnd: false })) as any;

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.data.status).toBe('cancelled');
    expect(mockSubscriptionsCancel).toHaveBeenCalledWith('sub_test123');
    expect(mockSubscriptionsUpdate).not.toHaveBeenCalled();
  });

  // ── 9. PATCH undo_cancellation — sets cancel_at_period_end=false, status='active' ──

  it('PATCH undo_cancellation sets cancel_at_period_end=false and status=active', async () => {
    ddbMock.on(GetCommand).resolves({ Item: cancellationRequestedSubscription });
    ddbMock.on(UpdateCommand).resolves({});
    mockSubscriptionsRetrieve.mockResolvedValue(makeStripeSubscription({
      cancel_at_period_end: true,
      status: 'active',
    }));
    mockSubscriptionsUpdate.mockResolvedValue(makeStripeSubscription({ cancel_at_period_end: false }));

    const res = await handler(makeEvent('PATCH', { action: 'undo_cancellation' })) as any;

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.data.status).toBe('active');
    expect(mockSubscriptionsUpdate).toHaveBeenCalledWith('sub_test123', {
      cancel_at_period_end: false,
    });
  });

  // ── 10. Returns 404 when no subscription found ─────────────────

  it('GET returns 200 with null subscription when no record found', async () => {
    ddbMock.on(GetCommand).resolves({ Item: undefined });

    const res = await handler(makeEvent('GET')) as any;

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.data.subscription).toBeNull();
    expect(body.data.status).toBe('none');
  });

  it('PUT returns 404 when no subscription found', async () => {
    ddbMock.on(GetCommand).resolves({ Item: undefined });

    const res = await handler(makeEvent('PUT', { action: 'pause' })) as any;

    expect(res.statusCode).toBe(404);
    const body = JSON.parse(res.body);
    expect(body.errorCode).toBe('NOT_FOUND');
  });

  it('DELETE returns 404 when no subscription found', async () => {
    ddbMock.on(GetCommand).resolves({ Item: undefined });

    const res = await handler(makeEvent('DELETE', { cancelAtCycleEnd: true })) as any;

    expect(res.statusCode).toBe(404);
    const body = JSON.parse(res.body);
    expect(body.errorCode).toBe('NOT_FOUND');
  });

  // ── 11. Returns 405 for unsupported HTTP method ────────────────

  it('returns 405 for unsupported HTTP method', async () => {
    const res = await handler(makeEvent('OPTIONS')) as any;

    expect(res.statusCode).toBe(405);
    const body = JSON.parse(res.body);
    expect(body.errorCode).toBe('VALIDATION_ERROR');
    expect(body.message).toContain('Method not allowed');
  });

  // ── Additional edge cases ──────────────────────────────────────

  it('PUT returns 400 for invalid action', async () => {
    ddbMock.on(GetCommand).resolves({ Item: activeSubscription });

    const res = await handler(makeEvent('PUT', { action: 'invalid' })) as any;

    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.errorCode).toBe('VALIDATION_ERROR');
  });

  it('PUT returns 400 when no Stripe subscription linked', async () => {
    const subWithoutStripe = { userId: 'user-1', status: 'active' };
    ddbMock.on(GetCommand).resolves({ Item: subWithoutStripe });

    const res = await handler(makeEvent('PUT', { action: 'pause' })) as any;

    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.errorCode).toBe('VALIDATION_ERROR');
    expect(body.message).toContain('No Stripe subscription linked');
  });

  it('PATCH returns 400 for invalid action', async () => {
    ddbMock.on(GetCommand).resolves({ Item: activeSubscription });

    const res = await handler(makeEvent('PATCH', { action: 'invalid' })) as any;

    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.errorCode).toBe('VALIDATION_ERROR');
  });

  it('PATCH returns 400 when subscription is not cancellation_requested', async () => {
    ddbMock.on(GetCommand).resolves({ Item: activeSubscription });

    const res = await handler(makeEvent('PATCH', { action: 'undo_cancellation' })) as any;

    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.errorCode).toBe('VALIDATION_ERROR');
    expect(body.message).toContain('not scheduled for cancellation');
  });

  it('DELETE returns 400 when subscription is already cancellation_requested', async () => {
    ddbMock.on(GetCommand).resolves({ Item: cancellationRequestedSubscription });

    const res = await handler(makeEvent('DELETE', { cancelAtCycleEnd: true })) as any;

    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.errorCode).toBe('VALIDATION_ERROR');
    expect(body.message).toContain('already scheduled for cancellation');
  });

  it('DELETE returns 400 when subscription is already cancelled', async () => {
    ddbMock.on(GetCommand).resolves({ Item: { ...activeSubscription, status: 'cancelled' } });

    const res = await handler(makeEvent('DELETE', { cancelAtCycleEnd: true })) as any;

    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.errorCode).toBe('VALIDATION_ERROR');
    expect(body.message).toContain('already cancelled');
  });

  it('GET returns DB data when Stripe retrieve fails', async () => {
    ddbMock.on(GetCommand).resolves({ Item: activeSubscription });
    mockSubscriptionsRetrieve.mockRejectedValue(new Error('Stripe error'));

    const res = await handler(makeEvent('GET')) as any;

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.data.subscription).toEqual(activeSubscription);
  });

  it('GET syncs status when Stripe status differs from DB', async () => {
    const dbSub = { ...activeSubscription, status: 'active' };
    ddbMock.on(GetCommand).resolves({ Item: dbSub });
    ddbMock.on(UpdateCommand).resolves({});
    mockSubscriptionsRetrieve.mockResolvedValue(makeStripeSubscription({
      status: 'past_due',
    }));

    const res = await handler(makeEvent('GET')) as any;

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.data.subscription.status).toBe('past_due');
  });

  it('DELETE defaults to cancelAtCycleEnd=true when body is empty', async () => {
    ddbMock.on(GetCommand).resolves({ Item: activeSubscription });
    ddbMock.on(UpdateCommand).resolves({});
    mockSubscriptionsUpdate.mockResolvedValue(makeStripeSubscription({ cancel_at_period_end: true }));

    const res = await handler(makeEvent('DELETE', {})) as any;

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.data.status).toBe('cancellation_requested');
    expect(mockSubscriptionsUpdate).toHaveBeenCalled();
    expect(mockSubscriptionsCancel).not.toHaveBeenCalled();
  });
});
