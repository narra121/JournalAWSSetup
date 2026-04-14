import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBDocumentClient, GetCommand, DeleteCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import type { APIGatewayProxyEventV2 } from 'aws-lambda';

vi.stubEnv('RULES_TABLE', 'test-rules');
vi.stubEnv('DAILY_STATS_TABLE', 'test-daily-stats');

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

function makeEvent(ruleId?: string, overrides: Partial<APIGatewayProxyEventV2> = {}): APIGatewayProxyEventV2 {
  return {
    version: '2.0',
    routeKey: 'DELETE /rules/{ruleId}',
    rawPath: `/rules/${ruleId || ''}`,
    rawQueryString: '',
    headers: {
      authorization: `Bearer ${makeJwt('user-1')}`,
    },
    pathParameters: ruleId ? { ruleId } : {},
    requestContext: {
      accountId: '123',
      apiId: 'api',
      domainName: 'api.example.com',
      domainPrefix: 'api',
      http: { method: 'DELETE', path: `/rules/${ruleId || ''}`, protocol: 'HTTP/1.1', sourceIp: '127.0.0.1', userAgent: 'test' },
      requestId: 'req-1',
      routeKey: 'DELETE /rules/{ruleId}',
      stage: '$default',
      time: '01/Jan/2024:00:00:00 +0000',
      timeEpoch: 0,
    },
    isBase64Encoded: false,
    ...overrides,
  } as unknown as APIGatewayProxyEventV2;
}

const existingRule = {
  userId: 'user-1',
  ruleId: 'rule-abc',
  rule: 'Never risk more than 1%',
  completed: false,
  isActive: true,
  createdAt: '2024-01-01T00:00:00.000Z',
  updatedAt: '2024-01-01T00:00:00.000Z',
};

// ─── Tests ──────────────────────────────────────────────────────

beforeEach(() => {
  ddbMock.reset();
});

describe('delete-rule handler', () => {
  it('returns 403 when subscription is inactive', async () => {
    const { checkSubscription } = await import('../../../shared/subscription');
    vi.mocked(checkSubscription).mockResolvedValueOnce({
      statusCode: 403,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ success: false, error: { code: 'SUBSCRIPTION_REQUIRED', message: 'Please subscribe', details: { reason: 'trial_expired' } } }),
    } as any);

    const res = await handler(makeEvent('rule-abc'), {} as any, () => {}) as any;

    expect(res.statusCode).toBe(403);
    const body = JSON.parse(res.body);
    expect(body.error.code).toBe('SUBSCRIPTION_REQUIRED');
  });

  // ── Success ─────────────────────────────────────────────────

  it('deletes a rule and returns 200 with the deleted rule data', async () => {
    ddbMock.on(GetCommand).resolves({ Item: existingRule });
    ddbMock.on(QueryCommand).resolves({ Items: [] });
    ddbMock.on(DeleteCommand).resolves({});

    const res = await handler(makeEvent('rule-abc'), {} as any, () => {}) as any;

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(true);
    expect(body.data.rule.ruleId).toBe('rule-abc');
    expect(body.data.rule.rule).toBe('Never risk more than 1%');
    expect(body.data.rule.userId).toBe('user-1');
  });

  // ── Auth errors ─────────────────────────────────────────────

  it('returns 401 when authorization header is missing', async () => {
    const event = makeEvent('rule-abc', { headers: {} });
    const res = await handler(event, {} as any, () => {}) as any;

    expect(res.statusCode).toBe(401);
    const body = JSON.parse(res.body);
    expect(body.errorCode).toBe('UNAUTHORIZED');
  });

  // ── Validation errors ───────────────────────────────────────

  it('returns 400 when ruleId is missing', async () => {
    const event = makeEvent(undefined);
    event.pathParameters = {};
    const res = await handler(event, {} as any, () => {}) as any;

    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.errorCode).toBe('VALIDATION_ERROR');
  });

  // ── Not found ───────────────────────────────────────────────

  it('returns 404 when rule does not exist', async () => {
    ddbMock.on(GetCommand).resolves({ Item: undefined });

    const res = await handler(makeEvent('nonexistent'), {} as any, () => {}) as any;

    expect(res.statusCode).toBe(404);
    const body = JSON.parse(res.body);
    expect(body.errorCode).toBe('TRADE_NOT_FOUND');
  });

  // ── DynamoDB errors ─────────────────────────────────────────

  it('returns 500 when DynamoDB fails', async () => {
    ddbMock.on(GetCommand).rejects(new Error('DynamoDB error'));

    const res = await handler(makeEvent('rule-abc'), {} as any, () => {}) as any;

    expect(res.statusCode).toBe(500);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(false);
    expect(body.errorCode).toBe('INTERNAL_ERROR');
  });

  // ── Additional coverage ─────────────────────────────────────

  it('returns 500 when DynamoDB DeleteCommand fails after successful Get', async () => {
    ddbMock.on(GetCommand).resolves({ Item: existingRule });
    ddbMock.on(QueryCommand).resolves({ Items: [] });
    ddbMock.on(DeleteCommand).rejects(new Error('Delete failed'));

    const res = await handler(makeEvent('rule-abc'), {} as any, () => {}) as any;

    expect(res.statusCode).toBe(500);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(false);
    expect(body.errorCode).toBe('INTERNAL_ERROR');
  });

  it('returns 401 when authorization token is malformed', async () => {
    const event = makeEvent('rule-abc', { headers: { authorization: 'Bearer not-a-jwt' } });
    const res = await handler(event, {} as any, () => {}) as any;

    expect(res.statusCode).toBe(401);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(false);
    expect(body.errorCode).toBe('UNAUTHORIZED');
  });

  it('returns 400 when pathParameters is undefined', async () => {
    const event = makeEvent(undefined);
    event.pathParameters = undefined as any;
    const res = await handler(event, {} as any, () => {}) as any;

    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.errorCode).toBe('VALIDATION_ERROR');
  });

  it('returns the full deleted rule object in response data', async () => {
    const fullRule = {
      ...existingRule,
      rule: 'Always use stop loss',
      ruleId: 'rule-xyz',
      completed: true,
      isActive: false,
    };
    ddbMock.on(GetCommand).resolves({ Item: fullRule });
    ddbMock.on(QueryCommand).resolves({ Items: [] });
    ddbMock.on(DeleteCommand).resolves({});

    const res = await handler(makeEvent('rule-xyz'), {} as any, () => {}) as any;

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.data.rule.ruleId).toBe('rule-xyz');
    expect(body.data.rule.rule).toBe('Always use stop loss');
    expect(body.data.rule.completed).toBe(true);
    expect(body.data.rule.isActive).toBe(false);
  });

  it('sends correct Key to GetCommand and DeleteCommand', async () => {
    ddbMock.on(GetCommand).resolves({ Item: existingRule });
    ddbMock.on(QueryCommand).resolves({ Items: [] });
    ddbMock.on(DeleteCommand).resolves({});

    await handler(makeEvent('rule-abc'), {} as any, () => {});

    const getCalls = ddbMock.commandCalls(GetCommand);
    expect(getCalls).toHaveLength(1);
    expect(getCalls[0].args[0].input.Key).toEqual({ userId: 'user-1', ruleId: 'rule-abc' });

    const deleteCalls = ddbMock.commandCalls(DeleteCommand);
    expect(deleteCalls).toHaveLength(1);
    expect(deleteCalls[0].args[0].input.Key).toEqual({ userId: 'user-1', ruleId: 'rule-abc' });
  });

  it('returns success message on delete', async () => {
    ddbMock.on(GetCommand).resolves({ Item: existingRule });
    ddbMock.on(QueryCommand).resolves({ Items: [] });
    ddbMock.on(DeleteCommand).resolves({});

    const res = await handler(makeEvent('rule-abc'), {} as any, () => {}) as any;

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.message).toBe('Rule deleted successfully');
  });

  it('returns 500 when DynamoDB throws ProvisionedThroughputExceededException', async () => {
    const awsError = new Error('Throughput exceeded');
    awsError.name = 'ProvisionedThroughputExceededException';
    ddbMock.on(GetCommand).rejects(awsError);

    const res = await handler(makeEvent('rule-abc'), {} as any, () => {}) as any;

    expect(res.statusCode).toBe(500);
    const body = JSON.parse(res.body);
    expect(body.errorCode).toBe('INTERNAL_ERROR');
  });

  it('does not call DeleteCommand when rule is not found', async () => {
    ddbMock.on(GetCommand).resolves({ Item: undefined });

    await handler(makeEvent('nonexistent'), {} as any, () => {});

    const deleteCalls = ddbMock.commandCalls(DeleteCommand);
    expect(deleteCalls).toHaveLength(0);
  });

  // ── Rule-in-use protection ──────────────────────────────────

  it('returns 409 when rule is referenced in DailyStats brokenRulesCounts', async () => {
    ddbMock.on(GetCommand).resolves({ Item: existingRule });
    ddbMock.on(QueryCommand).resolves({
      Items: [
        { userId: 'user-1', sk: 'acc-1#2024-01-15', brokenRulesCounts: { 'rule-abc': 2 } },
      ],
    });

    const res = await handler(makeEvent('rule-abc'), {} as any, () => {}) as any;

    expect(res.statusCode).toBe(409);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(false);
    expect(body.errorCode).toBe('RULE_IN_USE');
    expect(body.message).toContain('rule is broken in one or more trades');

    // DeleteCommand should NOT have been called
    const deleteCalls = ddbMock.commandCalls(DeleteCommand);
    expect(deleteCalls).toHaveLength(0);
  });

  it('deletes rule when not referenced by any DailyStats records', async () => {
    ddbMock.on(GetCommand).resolves({ Item: existingRule });
    ddbMock.on(QueryCommand).resolves({
      Items: [
        { userId: 'user-1', sk: 'acc-1#2024-01-15', brokenRulesCounts: {} },
        { userId: 'user-1', sk: 'acc-1#2024-01-16', brokenRulesCounts: { 'other-rule': 3 } },
      ],
    });
    ddbMock.on(DeleteCommand).resolves({});

    const res = await handler(makeEvent('rule-abc'), {} as any, () => {}) as any;

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(true);
    expect(body.data.rule.ruleId).toBe('rule-abc');

    const deleteCalls = ddbMock.commandCalls(DeleteCommand);
    expect(deleteCalls).toHaveLength(1);
  });

  it('deletes rule when DailyStats has no records at all', async () => {
    ddbMock.on(GetCommand).resolves({ Item: existingRule });
    ddbMock.on(QueryCommand).resolves({ Items: [] });
    ddbMock.on(DeleteCommand).resolves({});

    const res = await handler(makeEvent('rule-abc'), {} as any, () => {}) as any;

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(true);

    const deleteCalls = ddbMock.commandCalls(DeleteCommand);
    expect(deleteCalls).toHaveLength(1);
  });
});
