import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBDocumentClient, PutCommand } from '@aws-sdk/lib-dynamodb';
import type { APIGatewayProxyEventV2 } from 'aws-lambda';

vi.stubEnv('GOALS_TABLE', 'test-goals');

const ddbMock = mockClient(DynamoDBDocumentClient);

vi.mock('../../../shared/subscription', () => ({
  checkSubscription: vi.fn().mockResolvedValue(null),
}));

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
    routeKey: 'POST /goals',
    rawPath: '/goals',
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
      http: { method: 'POST', path: '/goals', protocol: 'HTTP/1.1', sourceIp: '127.0.0.1', userAgent: 'test' },
      requestId: 'req-1',
      routeKey: 'POST /goals',
      stage: '$default',
      time: '01/Jan/2024:00:00:00 +0000',
      timeEpoch: 0,
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
    isBase64Encoded: false,
    ...overrides,
  } as unknown as APIGatewayProxyEventV2;
}

function validGoalBody(overrides: Record<string, any> = {}) {
  return {
    goalType: 'profit',
    period: 'weekly',
    target: 500,
    ...overrides,
  };
}

// ─── Tests ──────────────────────────────────────────────────────

beforeEach(() => {
  ddbMock.reset();
  ddbMock.on(PutCommand).resolves({});
});

describe('create-goal handler', () => {
  // ── Success ─────────────────────────────────────────────────

  it('creates a goal and returns 201', async () => {
    const res = await handler(makeEvent(validGoalBody()), {} as any, () => {}) as any;

    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(true);
    expect(body.data.goal).toBeDefined();
    expect(body.data.goal.goalType).toBe('profit');
    expect(body.data.goal.period).toBe('weekly');
    expect(body.data.goal.target).toBe(500);
    expect(body.data.goal.userId).toBe('user-1');
  });

  it('creates goal with goalId, createdAt, updatedAt, and config fields', async () => {
    const res = await handler(makeEvent(validGoalBody()), {} as any, () => {}) as any;

    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body);
    const goal = body.data.goal;
    expect(goal.goalId).toBeDefined();
    expect(goal.createdAt).toBeDefined();
    expect(goal.updatedAt).toBeDefined();
    expect(goal.title).toBe('Profit Target');
    expect(goal.description).toBe('Reach your profit goal');
    expect(goal.unit).toBe('$');
    expect(goal.icon).toBe('target');
    expect(goal.color).toBe('text-primary');
    expect(goal.isInverse).toBe(false);
  });

  it('sets accountId to null when not provided', async () => {
    const res = await handler(makeEvent(validGoalBody()), {} as any, () => {}) as any;

    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body);
    expect(body.data.goal.accountId).toBeNull();
  });

  it('sets accountId when provided', async () => {
    const res = await handler(makeEvent(validGoalBody({ accountId: 'acct-123' })), {} as any, () => {}) as any;

    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body);
    expect(body.data.goal.accountId).toBe('acct-123');
  });

  it('creates goal with periodKey prefix in goalId', async () => {
    const res = await handler(makeEvent(validGoalBody({ periodKey: 'week#2026-04-07' })), {} as any, () => {}) as any;

    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body);
    expect(body.data.goal.goalId).toMatch(/^week#2026-04-07#/);
  });

  it('creates goal without periodKey prefix when periodKey not provided', async () => {
    const res = await handler(makeEvent(validGoalBody()), {} as any, () => {}) as any;

    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body);
    // goalId should be a plain UUID (no # prefix)
    expect(body.data.goal.goalId).not.toContain('#');
  });

  it('creates goal with month periodKey prefix', async () => {
    const res = await handler(makeEvent(validGoalBody({ periodKey: 'month#2026-04' })), {} as any, () => {}) as any;

    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body);
    expect(body.data.goal.goalId).toMatch(/^month#2026-04#/);
  });

  it('sends PutCommand to DynamoDB with correct table and item', async () => {
    await handler(makeEvent(validGoalBody()), {} as any, () => {}) as any;

    const putCalls = ddbMock.commandCalls(PutCommand);
    expect(putCalls).toHaveLength(1);
    expect(putCalls[0].args[0].input.TableName).toBe('test-goals');
    expect(putCalls[0].args[0].input.Item?.userId).toBe('user-1');
    expect(putCalls[0].args[0].input.Item?.goalType).toBe('profit');
  });

  it('returns success message', async () => {
    const res = await handler(makeEvent(validGoalBody()), {} as any, () => {}) as any;

    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body);
    expect(body.message).toBe('Goal created successfully');
  });

  it('creates goal for each valid goalType', async () => {
    const goalTypes = ['profit', 'winRate', 'maxDrawdown', 'maxTrades'];

    for (const goalType of goalTypes) {
      ddbMock.reset();
      ddbMock.on(PutCommand).resolves({});

      const res = await handler(makeEvent(validGoalBody({ goalType })), {} as any, () => {}) as any;

      expect(res.statusCode).toBe(201);
      const body = JSON.parse(res.body);
      expect(body.data.goal.goalType).toBe(goalType);
    }
  });

  it('creates goal for each valid period', async () => {
    const periods = ['weekly', 'monthly'];

    for (const period of periods) {
      ddbMock.reset();
      ddbMock.on(PutCommand).resolves({});

      const res = await handler(makeEvent(validGoalBody({ period })), {} as any, () => {}) as any;

      expect(res.statusCode).toBe(201);
      const body = JSON.parse(res.body);
      expect(body.data.goal.period).toBe(period);
    }
  });

  it('populates correct config for winRate goalType', async () => {
    const res = await handler(makeEvent(validGoalBody({ goalType: 'winRate' })), {} as any, () => {}) as any;

    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body);
    const goal = body.data.goal;
    expect(goal.title).toBe('Win Rate');
    expect(goal.unit).toBe('%');
    expect(goal.icon).toBe('trending-up');
    expect(goal.color).toBe('text-success');
    expect(goal.isInverse).toBe(false);
  });

  it('populates correct config for maxDrawdown goalType', async () => {
    const res = await handler(makeEvent(validGoalBody({ goalType: 'maxDrawdown' })), {} as any, () => {}) as any;

    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body);
    const goal = body.data.goal;
    expect(goal.title).toBe('Max Drawdown');
    expect(goal.isInverse).toBe(true);
  });

  it('populates correct config for maxTrades goalType', async () => {
    const res = await handler(makeEvent(validGoalBody({ goalType: 'maxTrades' })), {} as any, () => {}) as any;

    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body);
    const goal = body.data.goal;
    expect(goal.title).toBe('Max Trades');
    expect(goal.isInverse).toBe(true);
  });

  // ── Auth errors ─────────────────────────────────────────────

  it('returns 401 when authorization header is missing', async () => {
    const event = makeEvent(validGoalBody());
    event.headers = {};
    const res = await handler(event, {} as any, () => {}) as any;

    expect(res.statusCode).toBe(401);
    const body = JSON.parse(res.body);
    expect(body.errorCode).toBe('UNAUTHORIZED');
  });

  // ── Subscription errors ─────────────────────────────────────

  it('returns 403 when subscription is inactive', async () => {
    const { checkSubscription } = await import('../../../shared/subscription');
    vi.mocked(checkSubscription).mockResolvedValueOnce({
      statusCode: 403,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ success: false, error: { code: 'SUBSCRIPTION_REQUIRED', message: 'Please subscribe', details: { reason: 'trial_expired' } } }),
    } as any);

    const res = await handler(makeEvent(validGoalBody()), {} as any, () => {}) as any;

    expect(res.statusCode).toBe(403);
    const body = JSON.parse(res.body);
    expect(body.error.code).toBe('SUBSCRIPTION_REQUIRED');
  });

  // ── Validation errors ───────────────────────────────────────

  it('returns 400 when body is missing', async () => {
    const event = makeEvent(undefined);
    event.body = undefined;
    const res = await handler(event, {} as any, () => {}) as any;

    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.errorCode).toBe('VALIDATION_ERROR');
    expect(body.message).toContain('Missing body');
  });

  it('returns 400 when body is invalid JSON', async () => {
    const event = makeEvent(validGoalBody());
    event.body = '{not-valid-json';
    const res = await handler(event, {} as any, () => {}) as any;

    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.errorCode).toBe('VALIDATION_ERROR');
    expect(body.message).toContain('Invalid JSON');
  });

  // goalType validation

  it('returns 400 when goalType is missing', async () => {
    const res = await handler(makeEvent(validGoalBody({ goalType: undefined })), {} as any, () => {}) as any;

    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.errorCode).toBe('VALIDATION_ERROR');
    expect(body.message).toContain('goalType');
  });

  it('returns 400 when goalType is invalid', async () => {
    const res = await handler(makeEvent(validGoalBody({ goalType: 'invalid_type' })), {} as any, () => {}) as any;

    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.errorCode).toBe('VALIDATION_ERROR');
    expect(body.message).toContain('goalType');
  });

  it('returns 400 when goalType is empty string', async () => {
    const res = await handler(makeEvent(validGoalBody({ goalType: '' })), {} as any, () => {}) as any;

    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.errorCode).toBe('VALIDATION_ERROR');
  });

  // period validation

  it('returns 400 when period is missing', async () => {
    const res = await handler(makeEvent(validGoalBody({ period: undefined })), {} as any, () => {}) as any;

    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.errorCode).toBe('VALIDATION_ERROR');
    expect(body.message).toContain('period');
  });

  it('returns 400 when period is invalid', async () => {
    const res = await handler(makeEvent(validGoalBody({ period: 'yearly' })), {} as any, () => {}) as any;

    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.errorCode).toBe('VALIDATION_ERROR');
    expect(body.message).toContain('period');
  });

  it('returns 400 when period is daily (not a valid period)', async () => {
    const res = await handler(makeEvent(validGoalBody({ period: 'daily' })), {} as any, () => {}) as any;

    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.errorCode).toBe('VALIDATION_ERROR');
  });

  // target validation

  it('returns 400 when target is missing', async () => {
    const { target, ...bodyWithoutTarget } = validGoalBody();
    const res = await handler(makeEvent(bodyWithoutTarget), {} as any, () => {}) as any;

    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.errorCode).toBe('VALIDATION_ERROR');
    expect(body.message).toContain('target');
  });

  it('returns 400 when target is null', async () => {
    const res = await handler(makeEvent(validGoalBody({ target: null })), {} as any, () => {}) as any;

    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.errorCode).toBe('VALIDATION_ERROR');
    expect(body.message).toContain('target');
  });

  it('returns 400 when target is a string', async () => {
    const res = await handler(makeEvent(validGoalBody({ target: '500' })), {} as any, () => {}) as any;

    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.errorCode).toBe('VALIDATION_ERROR');
    expect(body.message).toContain('target');
  });

  it('allows target of zero', async () => {
    const res = await handler(makeEvent(validGoalBody({ target: 0 })), {} as any, () => {}) as any;

    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body);
    expect(body.data.goal.target).toBe(0);
  });

  it('allows negative target', async () => {
    const res = await handler(makeEvent(validGoalBody({ target: -10 })), {} as any, () => {}) as any;

    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body);
    expect(body.data.goal.target).toBe(-10);
  });

  // periodKey validation

  it('returns 400 when periodKey has invalid format', async () => {
    const res = await handler(makeEvent(validGoalBody({ periodKey: 'invalid-key' })), {} as any, () => {}) as any;

    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.errorCode).toBe('VALIDATION_ERROR');
    expect(body.message).toContain('periodKey');
  });

  it('returns 400 when periodKey has wrong week format', async () => {
    const res = await handler(makeEvent(validGoalBody({ periodKey: 'week#2026' })), {} as any, () => {}) as any;

    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.errorCode).toBe('VALIDATION_ERROR');
  });

  it('returns 400 when periodKey has wrong month format', async () => {
    const res = await handler(makeEvent(validGoalBody({ periodKey: 'month#2026-04-07' })), {} as any, () => {}) as any;

    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.errorCode).toBe('VALIDATION_ERROR');
  });

  it('accepts valid week periodKey format', async () => {
    const res = await handler(makeEvent(validGoalBody({ periodKey: 'week#2026-04-07' })), {} as any, () => {}) as any;

    expect(res.statusCode).toBe(201);
  });

  it('accepts valid month periodKey format', async () => {
    const res = await handler(makeEvent(validGoalBody({ periodKey: 'month#2026-04' })), {} as any, () => {}) as any;

    expect(res.statusCode).toBe(201);
  });

  it('succeeds when periodKey is not provided', async () => {
    const res = await handler(makeEvent(validGoalBody()), {} as any, () => {}) as any;

    expect(res.statusCode).toBe(201);
  });

  // ── DynamoDB errors ─────────────────────────────────────────

  it('returns 500 when DynamoDB write fails', async () => {
    ddbMock.on(PutCommand).rejects(new Error('DynamoDB write error'));

    const res = await handler(makeEvent(validGoalBody()), {} as any, () => {}) as any;

    expect(res.statusCode).toBe(500);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(false);
    expect(body.errorCode).toBe('INTERNAL_ERROR');
  });

  it('returns 500 when DynamoDB throws ProvisionedThroughputExceededException', async () => {
    const awsError = new Error('Throughput exceeded');
    awsError.name = 'ProvisionedThroughputExceededException';
    ddbMock.on(PutCommand).rejects(awsError);

    const res = await handler(makeEvent(validGoalBody()), {} as any, () => {}) as any;

    expect(res.statusCode).toBe(500);
    const body = JSON.parse(res.body);
    expect(body.errorCode).toBe('INTERNAL_ERROR');
  });
});
