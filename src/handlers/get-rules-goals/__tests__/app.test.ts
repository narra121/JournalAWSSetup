import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBDocumentClient, QueryCommand, BatchWriteCommand, GetCommand } from '@aws-sdk/lib-dynamodb';
import type { APIGatewayProxyEventV2 } from 'aws-lambda';

vi.stubEnv('RULES_TABLE', 'test-rules');
vi.stubEnv('GOALS_TABLE', 'test-goals');
vi.stubEnv('USER_PREFERENCES_TABLE', 'test-user-preferences');

const ddbMock = mockClient(DynamoDBDocumentClient);

const { handler, getPreviousPeriodKey, getPeriodType, isLegacyRecord } = await import('../app.ts');

// ─── Helpers ────────────────────────────────────────────────────

function makeJwt(sub: string): string {
  const header = btoa(JSON.stringify({ alg: 'RS256' }));
  const payload = btoa(JSON.stringify({ sub }));
  return `${header}.${payload}.sig`;
}

function makeEvent(overrides: Partial<APIGatewayProxyEventV2> = {}): APIGatewayProxyEventV2 {
  return {
    version: '2.0',
    routeKey: 'GET /rules-goals',
    rawPath: '/rules-goals',
    rawQueryString: '',
    headers: {
      authorization: `Bearer ${makeJwt('user-1')}`,
    },
    requestContext: {
      accountId: '123',
      apiId: 'api',
      domainName: 'api.example.com',
      domainPrefix: 'api',
      http: { method: 'GET', path: '/rules-goals', protocol: 'HTTP/1.1', sourceIp: '127.0.0.1', userAgent: 'test' },
      requestId: 'req-1',
      routeKey: 'GET /rules-goals',
      stage: '$default',
      time: '01/Jan/2024:00:00:00 +0000',
      timeEpoch: 0,
    },
    isBase64Encoded: false,
    ...overrides,
  } as unknown as APIGatewayProxyEventV2;
}

const existingRules = [
  { userId: 'user-1', ruleId: 'r1', rule: 'Never risk more than 1%', completed: false, isActive: true },
  { userId: 'user-1', ruleId: 'r2', rule: 'Always set stop loss', completed: true, isActive: true },
];

const existingGoals = [
  { userId: 'user-1', goalId: 'g1', title: 'Monthly profit target', target: 5000, period: 'monthly' },
  { userId: 'user-1', goalId: 'g2', title: 'Win rate above 60%', target: 60, period: 'weekly' },
];

const periodRules = [
  { userId: 'user-1', ruleId: 'week#2026-04-07#r1', rule: 'Never risk more than 1%', completed: false, isActive: true },
  { userId: 'user-1', ruleId: 'week#2026-04-07#r2', rule: 'Always set stop loss', completed: true, isActive: true },
];

const periodGoals = [
  { userId: 'user-1', goalId: 'week#2026-04-07#g1', goalType: 'profit', target: 500, period: 'weekly' },
];

const prevPeriodRules = [
  { userId: 'user-1', ruleId: 'week#2026-03-31#pr1', rule: 'Previous rule 1', completed: false, isActive: true },
  { userId: 'user-1', ruleId: 'week#2026-03-31#pr2', rule: 'Previous rule 2', completed: true, isActive: true },
];

const prevPeriodGoals = [
  { userId: 'user-1', goalId: 'week#2026-03-31#pg1', goalType: 'winRate', target: 65, period: 'weekly' },
];

// ─── Tests ──────────────────────────────────────────────────────

beforeEach(() => {
  ddbMock.reset();
});

describe('get-rules-goals handler', () => {
  // ── Backward-compatible (no periodKey) ──────────────────────

  it('returns existing rules and goals with meta counts', async () => {
    ddbMock.on(QueryCommand)
      .resolvesOnce({ Items: existingRules })
      .resolvesOnce({ Items: existingGoals });

    const res = await handler(makeEvent(), {} as any, () => {}) as any;

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(true);
    expect(body.data.rules).toHaveLength(2);
    expect(body.data.goals).toHaveLength(2);
    expect(body.data.meta.rulesCount).toBe(2);
    expect(body.data.meta.goalsCount).toBe(2);
  });

  it('creates default rules when user has none', async () => {
    ddbMock.on(QueryCommand)
      .resolvesOnce({ Items: [] })          // rules query returns empty
      .resolvesOnce({ Items: existingGoals }); // goals query returns data
    ddbMock.on(BatchWriteCommand).resolves({ UnprocessedItems: {} });

    const res = await handler(makeEvent(), {} as any, () => {}) as any;

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(true);
    // Default rules should have been created (6 default rules)
    expect(body.data.rules.length).toBe(6);
    expect(body.data.meta.rulesCount).toBe(6);
    // Verify BatchWriteCommand was called to persist default rules
    const batchCalls = ddbMock.commandCalls(BatchWriteCommand);
    expect(batchCalls.length).toBeGreaterThanOrEqual(1);
  });

  it('backward compatible — returns all rules when no periodKey', async () => {
    ddbMock.on(QueryCommand)
      .resolvesOnce({ Items: existingRules })
      .resolvesOnce({ Items: existingGoals });

    const res = await handler(makeEvent(), {} as any, () => {}) as any;

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.data.rules).toHaveLength(2);
    expect(body.data.goals).toHaveLength(2);
    // No periodKey in meta
    expect(body.data.meta.periodKey).toBeUndefined();
  });

  // ── Period-specific queries ─────────────────────────────────

  it('returns period-specific rules when periodKey provided', async () => {
    // 1st query: rules with begins_with prefix
    // 2nd query: goals with begins_with prefix
    ddbMock.on(QueryCommand)
      .resolvesOnce({ Items: periodRules })
      .resolvesOnce({ Items: periodGoals });

    const event = makeEvent({
      queryStringParameters: { periodKey: 'week#2026-04-07' },
    } as any);

    const res = await handler(event, {} as any, () => {}) as any;

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.data.rules).toHaveLength(2);
    expect(body.data.goals).toHaveLength(1);
    expect(body.data.meta.periodKey).toBe('week#2026-04-07');
    // Verify begins_with query was used
    const queryCalls = ddbMock.commandCalls(QueryCommand);
    expect(queryCalls[0].args[0].input.KeyConditionExpression).toContain('begins_with');
  });

  // ── Clone-on-write ──────────────────────────────────────────

  it('clones previous period rules when carry-forward ON and no current records', async () => {
    // 1st+2nd query: current period — empty
    ddbMock.on(QueryCommand)
      .resolvesOnce({ Items: [] }) // current rules
      .resolvesOnce({ Items: [] }) // current goals
      .resolvesOnce({ Items: prevPeriodRules }) // prev period rules
      .resolvesOnce({ Items: prevPeriodGoals }); // prev period goals

    // GetCommand for user preferences: carry-forward ON
    ddbMock.on(GetCommand).resolves({
      Item: { userId: 'user-1', carryForwardGoalsRules: true },
    });

    ddbMock.on(BatchWriteCommand).resolves({ UnprocessedItems: {} });

    const event = makeEvent({
      queryStringParameters: { periodKey: 'week#2026-04-07', currentPeriod: 'true' },
    } as any);

    const res = await handler(event, {} as any, () => {}) as any;

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    // Cloned rules should have new periodKey prefix
    expect(body.data.rules).toHaveLength(2);
    expect(body.data.goals).toHaveLength(1);
    expect(body.data.meta.cloned).toBe(true);
    // New ruleId should contain the current periodKey
    for (const rule of body.data.rules) {
      expect(rule.ruleId).toMatch(/^week#2026-04-07#/);
    }
    for (const goal of body.data.goals) {
      expect(goal.goalId).toMatch(/^week#2026-04-07#/);
    }
    // Verify BatchWriteCommand was called
    const batchCalls = ddbMock.commandCalls(BatchWriteCommand);
    expect(batchCalls.length).toBeGreaterThanOrEqual(1);
  });

  it('clones legacy records when no previous period records exist and carry-forward ON', async () => {
    // Current period — empty
    ddbMock.on(QueryCommand)
      .resolvesOnce({ Items: [] }) // current rules (prefix query)
      .resolvesOnce({ Items: [] }) // current goals (prefix query)
      .resolvesOnce({ Items: [] }) // prev period rules (prefix query)
      .resolvesOnce({ Items: [] }) // prev period goals (prefix query)
      .resolvesOnce({ Items: existingRules }) // legacy rules (all records)
      .resolvesOnce({ Items: existingGoals }); // legacy goals (all records)

    ddbMock.on(GetCommand).resolves({
      Item: { userId: 'user-1', carryForwardGoalsRules: true },
    });

    ddbMock.on(BatchWriteCommand).resolves({ UnprocessedItems: {} });

    const event = makeEvent({
      queryStringParameters: { periodKey: 'week#2026-04-07', currentPeriod: 'true' },
    } as any);

    const res = await handler(event, {} as any, () => {}) as any;

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.data.rules).toHaveLength(2);
    expect(body.data.goals).toHaveLength(2);
    expect(body.data.meta.cloned).toBe(true);
    // Should have new periodKey in the IDs
    for (const rule of body.data.rules) {
      expect(rule.ruleId).toMatch(/^week#2026-04-07#/);
    }
  });

  it('creates defaults when carry-forward OFF and no current records', async () => {
    // Current period — empty
    ddbMock.on(QueryCommand)
      .resolvesOnce({ Items: [] }) // current rules
      .resolvesOnce({ Items: [] }); // current goals

    // GetCommand for user preferences: carry-forward OFF
    ddbMock.on(GetCommand).resolves({
      Item: { userId: 'user-1', carryForwardGoalsRules: false },
    });

    ddbMock.on(BatchWriteCommand).resolves({ UnprocessedItems: {} });

    const event = makeEvent({
      queryStringParameters: { periodKey: 'week#2026-04-07', currentPeriod: 'true' },
    } as any);

    const res = await handler(event, {} as any, () => {}) as any;

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    // 6 default rules, 4 default weekly goals
    expect(body.data.rules).toHaveLength(6);
    expect(body.data.goals).toHaveLength(4);
    expect(body.data.meta.cloned).toBe(true);
    // Verify period-stamped IDs
    for (const rule of body.data.rules) {
      expect(rule.ruleId).toMatch(/^week#2026-04-07#/);
    }
    for (const goal of body.data.goals) {
      expect(goal.goalId).toMatch(/^week#2026-04-07#/);
      expect(goal.period).toBe('weekly');
    }
  });

  it('creates monthly defaults when carry-forward OFF and monthly periodKey', async () => {
    ddbMock.on(QueryCommand)
      .resolvesOnce({ Items: [] })
      .resolvesOnce({ Items: [] });

    ddbMock.on(GetCommand).resolves({
      Item: { userId: 'user-1', carryForwardGoalsRules: false },
    });

    ddbMock.on(BatchWriteCommand).resolves({ UnprocessedItems: {} });

    const event = makeEvent({
      queryStringParameters: { periodKey: 'month#2026-04', currentPeriod: 'true' },
    } as any);

    const res = await handler(event, {} as any, () => {}) as any;

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.data.rules).toHaveLength(6);
    expect(body.data.goals).toHaveLength(4);
    for (const goal of body.data.goals) {
      expect(goal.goalId).toMatch(/^month#2026-04#/);
      expect(goal.period).toBe('monthly');
    }
    // Verify monthly targets
    const profitGoal = body.data.goals.find((g: any) => g.goalType === 'profit');
    expect(profitGoal.target).toBe(2000);
    const winRateGoal = body.data.goals.find((g: any) => g.goalType === 'winRate');
    expect(winRateGoal.target).toBe(70);
  });

  it('returns empty for past period with no records', async () => {
    ddbMock.on(QueryCommand)
      .resolvesOnce({ Items: [] })
      .resolvesOnce({ Items: [] });

    const event = makeEvent({
      queryStringParameters: { periodKey: 'week#2026-03-24' },
    } as any);

    const res = await handler(event, {} as any, () => {}) as any;

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.data.rules).toEqual([]);
    expect(body.data.goals).toEqual([]);
    expect(body.data.meta.periodKey).toBe('week#2026-03-24');
    // No BatchWriteCommand should have been called (no clone)
    const batchCalls = ddbMock.commandCalls(BatchWriteCommand);
    expect(batchCalls).toHaveLength(0);
  });

  it('returns empty for past period with currentPeriod=false', async () => {
    ddbMock.on(QueryCommand)
      .resolvesOnce({ Items: [] })
      .resolvesOnce({ Items: [] });

    const event = makeEvent({
      queryStringParameters: { periodKey: 'week#2026-03-24', currentPeriod: 'false' },
    } as any);

    const res = await handler(event, {} as any, () => {}) as any;

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.data.rules).toEqual([]);
    expect(body.data.goals).toEqual([]);
  });

  // ── Auth errors ─────────────────────────────────────────────

  it('returns 401 when authorization header is missing', async () => {
    const event = makeEvent({ headers: {} });
    const res = await handler(event, {} as any, () => {}) as any;

    expect(res.statusCode).toBe(401);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(false);
    expect(body.errorCode).toBe('UNAUTHORIZED');
  });

  // ── DynamoDB errors ─────────────────────────────────────────

  it('returns 500 when DynamoDB fails', async () => {
    ddbMock.on(QueryCommand).rejects(new Error('DynamoDB error'));

    const res = await handler(makeEvent(), {} as any, () => {}) as any;

    expect(res.statusCode).toBe(500);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(false);
    expect(body.errorCode).toBe('INTERNAL_ERROR');
  });

  // ── Additional coverage ─────────────────────────────────────

  it('returns existing rules with empty goals', async () => {
    ddbMock.on(QueryCommand)
      .resolvesOnce({ Items: existingRules })
      .resolvesOnce({ Items: [] });

    const res = await handler(makeEvent(), {} as any, () => {}) as any;

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.data.rules).toHaveLength(2);
    expect(body.data.goals).toEqual([]);
    expect(body.data.meta.rulesCount).toBe(2);
    expect(body.data.meta.goalsCount).toBe(0);
  });

  it('creates default rules when no rules exist and returns empty goals', async () => {
    ddbMock.on(QueryCommand)
      .resolvesOnce({ Items: [] })
      .resolvesOnce({ Items: [] });
    ddbMock.on(BatchWriteCommand).resolves({ UnprocessedItems: {} });

    const res = await handler(makeEvent(), {} as any, () => {}) as any;

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.data.rules).toHaveLength(6);
    expect(body.data.goals).toEqual([]);
    expect(body.data.meta.rulesCount).toBe(6);
    expect(body.data.meta.goalsCount).toBe(0);
  });

  it('returns 401 when authorization token is malformed', async () => {
    const event = makeEvent({ headers: { authorization: 'Bearer not-a-jwt' } });
    const res = await handler(event, {} as any, () => {}) as any;

    expect(res.statusCode).toBe(401);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(false);
    expect(body.errorCode).toBe('UNAUTHORIZED');
  });

  it('returns 500 when rules query fails but goals would succeed', async () => {
    ddbMock.on(QueryCommand)
      .resolvesOnce(Promise.reject(new Error('Rules query failed')))
      .resolvesOnce({ Items: existingGoals });

    const res = await handler(makeEvent(), {} as any, () => {}) as any;

    expect(res.statusCode).toBe(500);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(false);
    expect(body.errorCode).toBe('INTERNAL_ERROR');
  });

  it('returns 500 when goals query fails but rules would succeed', async () => {
    ddbMock.on(QueryCommand)
      .resolvesOnce({ Items: existingRules })
      .resolvesOnce(Promise.reject(new Error('Goals query failed')));

    const res = await handler(makeEvent(), {} as any, () => {}) as any;

    expect(res.statusCode).toBe(500);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(false);
    expect(body.errorCode).toBe('INTERNAL_ERROR');
  });

  it('queries DynamoDB with correct userId from JWT', async () => {
    ddbMock.on(QueryCommand)
      .resolvesOnce({ Items: [] })
      .resolvesOnce({ Items: [] });
    ddbMock.on(BatchWriteCommand).resolves({ UnprocessedItems: {} });

    const event = makeEvent({
      headers: { authorization: `Bearer ${makeJwt('user-99')}` },
    });
    const res = await handler(event, {} as any, () => {}) as any;

    expect(res.statusCode).toBe(200);
    const queryCalls = ddbMock.commandCalls(QueryCommand);
    expect(queryCalls).toHaveLength(2);
    expect(queryCalls[0].args[0].input.ExpressionAttributeValues).toEqual({ ':userId': 'user-99' });
    expect(queryCalls[1].args[0].input.ExpressionAttributeValues).toEqual({ ':userId': 'user-99' });
  });

  it('handles Items being undefined in both query results', async () => {
    ddbMock.on(QueryCommand)
      .resolvesOnce({ Items: undefined })
      .resolvesOnce({ Items: undefined });
    ddbMock.on(BatchWriteCommand).resolves({ UnprocessedItems: {} });

    const res = await handler(makeEvent(), {} as any, () => {}) as any;

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    // Should create default rules since no rules exist
    expect(body.data.rules).toHaveLength(6);
    expect(body.data.goals).toEqual([]);
  });

  it('response includes success message', async () => {
    ddbMock.on(QueryCommand)
      .resolvesOnce({ Items: existingRules })
      .resolvesOnce({ Items: existingGoals });

    const res = await handler(makeEvent(), {} as any, () => {}) as any;

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.message).toBe('Rules and goals retrieved');
  });

  it('returns 500 when DynamoDB throws ProvisionedThroughputExceededException', async () => {
    const awsError = new Error('Throughput exceeded');
    awsError.name = 'ProvisionedThroughputExceededException';
    ddbMock.on(QueryCommand).rejects(awsError);

    const res = await handler(makeEvent(), {} as any, () => {}) as any;

    expect(res.statusCode).toBe(500);
    const body = JSON.parse(res.body);
    expect(body.errorCode).toBe('INTERNAL_ERROR');
  });

  // ── Clone-on-write: defaults when no source at all ──────────

  it('creates defaults when carry-forward ON but no previous or legacy records', async () => {
    // Current period — empty
    ddbMock.on(QueryCommand)
      .resolvesOnce({ Items: [] }) // current rules
      .resolvesOnce({ Items: [] }) // current goals
      .resolvesOnce({ Items: [] }) // prev period rules
      .resolvesOnce({ Items: [] }) // prev period goals
      .resolvesOnce({ Items: [] }) // legacy rules (all records query)
      .resolvesOnce({ Items: [] }); // legacy goals (all records query)

    ddbMock.on(GetCommand).resolves({
      Item: { userId: 'user-1', carryForwardGoalsRules: true },
    });

    ddbMock.on(BatchWriteCommand).resolves({ UnprocessedItems: {} });

    const event = makeEvent({
      queryStringParameters: { periodKey: 'week#2026-04-07', currentPeriod: 'true' },
    } as any);

    const res = await handler(event, {} as any, () => {}) as any;

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    // Defaults: 6 rules, 4 goals
    expect(body.data.rules).toHaveLength(6);
    expect(body.data.goals).toHaveLength(4);
    expect(body.data.meta.cloned).toBe(true);
  });

  it('defaults carry-forward to true when preferences not found', async () => {
    // Current period — empty
    ddbMock.on(QueryCommand)
      .resolvesOnce({ Items: [] }) // current rules
      .resolvesOnce({ Items: [] }) // current goals
      .resolvesOnce({ Items: prevPeriodRules }) // prev period rules
      .resolvesOnce({ Items: prevPeriodGoals }); // prev period goals

    // No preferences record
    ddbMock.on(GetCommand).resolves({ Item: undefined });

    ddbMock.on(BatchWriteCommand).resolves({ UnprocessedItems: {} });

    const event = makeEvent({
      queryStringParameters: { periodKey: 'week#2026-04-07', currentPeriod: 'true' },
    } as any);

    const res = await handler(event, {} as any, () => {}) as any;

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    // Should clone from previous period (carry-forward defaults to true)
    expect(body.data.rules).toHaveLength(2);
    expect(body.data.meta.cloned).toBe(true);
  });
});

// ─── Helper unit tests ──────────────────────────────────────────

describe('getPreviousPeriodKey', () => {
  it('computes previous week', () => {
    expect(getPreviousPeriodKey('week#2026-04-07')).toBe('week#2026-03-31');
  });

  it('computes previous week across year boundary', () => {
    expect(getPreviousPeriodKey('week#2026-01-05')).toBe('week#2025-12-29');
  });

  it('computes previous month', () => {
    expect(getPreviousPeriodKey('month#2026-04')).toBe('month#2026-03');
  });

  it('computes previous month across year boundary', () => {
    expect(getPreviousPeriodKey('month#2026-01')).toBe('month#2025-12');
  });

  it('returns input for unknown format', () => {
    expect(getPreviousPeriodKey('unknown#key')).toBe('unknown#key');
  });
});

describe('getPeriodType', () => {
  it('returns weekly for week keys', () => {
    expect(getPeriodType('week#2026-04-07')).toBe('weekly');
  });

  it('returns monthly for month keys', () => {
    expect(getPeriodType('month#2026-04')).toBe('monthly');
  });
});

describe('isLegacyRecord', () => {
  it('returns true for UUID-only keys', () => {
    expect(isLegacyRecord('abc-123-def')).toBe(true);
  });

  it('returns false for week-prefixed keys', () => {
    expect(isLegacyRecord('week#2026-04-07#abc')).toBe(false);
  });

  it('returns false for month-prefixed keys', () => {
    expect(isLegacyRecord('month#2026-04#abc')).toBe(false);
  });
});
