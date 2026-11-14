import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBDocumentClient, QueryCommand, BatchWriteCommand, GetCommand } from '@aws-sdk/lib-dynamodb';
import type { APIGatewayProxyEventV2 } from 'aws-lambda';

vi.stubEnv('RULES_TABLE', 'test-rules');
vi.stubEnv('GOALS_TABLE', 'test-goals');
vi.stubEnv('USER_PREFERENCES_TABLE', 'test-user-preferences');

const ddbMock = mockClient(DynamoDBDocumentClient);

const { handler, getPreviousPeriodKey, getPeriodType, isLegacyRecord, periodHoldsDay, materializePeriod } = await import('../app.ts');

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

// A Wednesday inside the week of 2026-04-07 and the month 2026-04: the periods the clone-on-write tests call current.
const NOW = '2026-04-08T10:00:00Z';

beforeEach(() => {
  ddbMock.reset();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(NOW));
});

afterEach(() => {
  vi.useRealTimers();
});

describe('get-rules-goals handler', () => {
  // ── periodKey validation (BE-044) ───────────────────────────

  it.each(['x1', 'week#2026-13-40', 'week#2026-04-07x', 'month#2026-13', 'month#2026-00', 'week#2026-02-30', 'quarter#2026-Q1'])(
    'a GET with periodKey %s is a 400 and writes nothing',
    async (periodKey) => {
      const res = await handler(makeEvent({ queryStringParameters: { periodKey, currentPeriod: 'true' } } as any), {} as any, () => {}) as any;

      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body).errorCode).toBe('VALIDATION_ERROR');
      expect(ddbMock.commandCalls(QueryCommand)).toHaveLength(0);
      expect(ddbMock.commandCalls(BatchWriteCommand)).toHaveLength(0);
    },
  );

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

  it('a period copy keeps the dates of what it copies, so the first-run checklist does not count it as set by the user', async () => {
    const stamped = (r: Record<string, unknown>) => ({ ...r, createdAt: '2026-03-31T08:00:00.000Z', updatedAt: '2026-03-31T08:00:00.000Z' });
    ddbMock.on(QueryCommand)
      .resolvesOnce({ Items: [] })
      .resolvesOnce({ Items: [] })
      .resolvesOnce({ Items: prevPeriodRules.map(stamped) })
      .resolvesOnce({ Items: [stamped(prevPeriodGoals[0])] });
    ddbMock.on(GetCommand).resolves({ Item: { userId: 'user-1', carryForwardGoalsRules: true } });
    ddbMock.on(BatchWriteCommand).resolves({ UnprocessedItems: {} });

    const res = (await handler(makeEvent({ queryStringParameters: { periodKey: 'week#2026-04-07', currentPeriod: 'true' } } as any), {} as any, () => {})) as any;

    const body = JSON.parse(res.body);
    for (const item of [...body.data.rules, ...body.data.goals]) {
      expect(item.createdAt).toBe('2026-03-31T08:00:00.000Z');
      expect(item.updatedAt).toBe('2026-03-31T08:00:00.000Z');
    }
  });

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
    // A GET never writes: the copies are stored by the first write to the period (materializePeriod).
    expect(ddbMock.commandCalls(BatchWriteCommand)).toHaveLength(0);
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
    // A weekly period takes the weekly legacy goal only, not the monthly one (M2).
    expect(body.data.goals.map((g: any) => g.goalId)).toEqual(['week#2026-04-07#g2']);
    expect(body.data.goals.every((g: any) => g.period === 'weekly')).toBe(true);
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
    // 6 starter rules; no goals are made up (a goal exists only once the user sets one), and nothing is written
    expect(body.data.rules).toHaveLength(6);
    expect(body.data.goals).toHaveLength(0);
    expect(body.data.meta.cloned).toBe(true);
    for (const rule of body.data.rules) {
      expect(rule.ruleId).toMatch(/^week#2026-04-07#/);
    }
    expect(ddbMock.commandCalls(BatchWriteCommand)).toHaveLength(0);
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
    for (const rule of body.data.rules) expect(rule.ruleId).toMatch(/^month#2026-04#/);
    expect(body.data.goals).toHaveLength(0);
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

  // ── Client-side filtering of period-prefixed records ─────────

  it('filters out period-prefixed records (week#, month#) from legacy query', async () => {
    // The handler was changed from server-side FilterExpression to client-side array filter.
    // When no periodKey is given, the backward-compatible path queries all records.
    // The legacy queryLegacyRecords function is used in clone-on-write path.
    // But we can verify the behavior by testing the clone-on-write path that
    // falls back to legacy records which mixes period and non-period records.

    // Set up: current period empty, prev period empty, legacy query returns a mix
    const mixedRules = [
      { userId: 'user-1', ruleId: 'legacy-r1', rule: 'Legacy rule 1', completed: false, isActive: true },
      { userId: 'user-1', ruleId: 'legacy-r2', rule: 'Legacy rule 2', completed: false, isActive: true },
      { userId: 'user-1', ruleId: 'week#2026-03-31#r1', rule: 'Week rule (should be filtered)', completed: false, isActive: true },
      { userId: 'user-1', ruleId: 'month#2026-03#r1', rule: 'Month rule (should be filtered)', completed: false, isActive: true },
    ];
    const mixedGoals = [
      { userId: 'user-1', goalId: 'legacy-g1', goalType: 'profit', target: 1000, period: 'weekly' },
      { userId: 'user-1', goalId: 'week#2026-03-31#g1', goalType: 'winRate', target: 60, period: 'weekly' },
      { userId: 'user-1', goalId: 'month#2026-03#g1', goalType: 'profit', target: 5000, period: 'monthly' },
    ];

    ddbMock.on(QueryCommand)
      .resolvesOnce({ Items: [] }) // current period rules (prefix query)
      .resolvesOnce({ Items: [] }) // current period goals (prefix query)
      .resolvesOnce({ Items: [] }) // prev period rules (prefix query)
      .resolvesOnce({ Items: [] }) // prev period goals (prefix query)
      .resolvesOnce({ Items: mixedRules }) // legacy rules query (all records)
      .resolvesOnce({ Items: mixedGoals }); // legacy goals query (all records)

    ddbMock.on(GetCommand).resolves({
      Item: { userId: 'user-1', carryForwardGoalsRules: true },
    });

    ddbMock.on(BatchWriteCommand).resolves({ UnprocessedItems: {} });

    vi.setSystemTime(new Date('2026-04-15T10:00:00Z'));
    const event = makeEvent({
      queryStringParameters: { periodKey: 'week#2026-04-14', currentPeriod: 'true' },
    } as any);

    const res = await handler(event, {} as any, () => {}) as any;

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);

    // Only legacy records (non-period-prefixed) should be cloned.
    // The queryLegacyRecords function filters out week# and month# prefixed sort keys.
    // So we expect 2 rules (legacy-r1, legacy-r2) and 1 goal (legacy-g1) to be cloned.
    expect(body.data.rules).toHaveLength(2);
    expect(body.data.goals).toHaveLength(1);

    // Cloned records should have the new periodKey prefix
    for (const rule of body.data.rules) {
      expect(rule.ruleId).toMatch(/^week#2026-04-14#/);
    }
    for (const goal of body.data.goals) {
      expect(goal.goalId).toMatch(/^week#2026-04-14#/);
    }

    // Verify the original rule text was preserved during cloning
    const ruleTexts = body.data.rules.map((r: any) => r.rule);
    expect(ruleTexts).toContain('Legacy rule 1');
    expect(ruleTexts).toContain('Legacy rule 2');
    // Period-prefixed rules should NOT be present
    expect(ruleTexts).not.toContain('Week rule (should be filtered)');
    expect(ruleTexts).not.toContain('Month rule (should be filtered)');
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
    // Starter rules only, no goals
    expect(body.data.rules).toHaveLength(6);
    expect(body.data.goals).toHaveLength(0);
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

// ─── Legacy cloning by period, and the currentPeriod claim (M2) ─────

describe('legacy goals are cloned by period kind (M2)', () => {
  const legacy = [
    { userId: 'user-1', goalId: 'lw', goalType: 'profit', target: 500, period: 'weekly', accountId: 'acc-1' },
    { userId: 'user-1', goalId: 'lm', goalType: 'profit', target: 2000, period: 'monthly', accountId: 'acc-1' },
    { userId: 'user-1', goalId: 'lw2', goalType: 'winRate', target: 65, period: 'weekly', accountId: 'acc-1' },
    { userId: 'user-1', goalId: 'lnone', goalType: 'maxTrades', target: 8, accountId: 'acc-1' },
  ];
  const run = async (periodKey: string) => {
    ddbMock.on(QueryCommand)
      .resolvesOnce({ Items: [] }).resolvesOnce({ Items: [] }) // the period
      .resolvesOnce({ Items: [] }).resolvesOnce({ Items: [] }) // the previous period
      .resolvesOnce({ Items: [] }).resolvesOnce({ Items: legacy }); // legacy rules, legacy goals
    ddbMock.on(GetCommand).resolves({ Item: { userId: 'user-1', carryForwardGoalsRules: true } });
    ddbMock.on(BatchWriteCommand).resolves({ UnprocessedItems: {} });
    const res = (await handler(makeEvent({ queryStringParameters: { periodKey, currentPeriod: 'true' } } as any), {} as any, () => {})) as any;
    return JSON.parse(res.body).data.goals as any[];
  };

  it('a weekly period gets the weekly legacy goals only', async () => {
    expect((await run('week#2026-04-07')).map((g) => g.goalId).sort()).toEqual(['week#2026-04-07#lw', 'week#2026-04-07#lw2']);
  });

  it('a monthly period gets the monthly legacy goals only', async () => {
    expect((await run('month#2026-04')).map((g) => g.goalId)).toEqual(['month#2026-04#lm']);
  });

  it('the first write stores the same filtered set the GET showed (materializePeriod)', async () => {
    await run('week#2026-04-07');
    expect(ddbMock.commandCalls(BatchWriteCommand)).toHaveLength(0);
    ddbMock.reset();
    ddbMock.on(QueryCommand)
      .resolvesOnce({ Items: [] }).resolvesOnce({ Items: [] }) // the period (still empty)
      .resolvesOnce({ Items: [] }).resolvesOnce({ Items: [] }) // the previous period
      .resolvesOnce({ Items: [] }).resolvesOnce({ Items: legacy }); // legacy rules, legacy goals
    ddbMock.on(GetCommand).resolves({ Item: { userId: 'user-1', carryForwardGoalsRules: true } });
    ddbMock.on(BatchWriteCommand).resolves({ UnprocessedItems: {} });
    await materializePeriod('user-1', 'week#2026-04-07');
    const written = ddbMock.commandCalls(BatchWriteCommand).flatMap((c) => Object.entries(c.args[0].input.RequestItems!))
      .filter(([table]) => table === 'test-goals').flatMap(([, reqs]) => (reqs as any[]).map((r) => r.PutRequest.Item.goalId));
    expect(written.sort()).toEqual(['week#2026-04-07#lw', 'week#2026-04-07#lw2']);
  });
});

describe('currentPeriod=true is checked by the server (M2)', () => {
  const nothingStored = () => {
    ddbMock.on(QueryCommand).resolves({ Items: [] });
    ddbMock.on(GetCommand).resolves({ Item: { userId: 'user-1', carryForwardGoalsRules: false } });
    ddbMock.on(BatchWriteCommand).resolves({ UnprocessedItems: {} });
  };
  const get = async (periodKey: string, currentPeriod = 'true') => {
    const res = (await handler(makeEvent({ queryStringParameters: { periodKey, currentPeriod } } as any), {} as any, () => {})) as any;
    return JSON.parse(res.body).data;
  };

  it.each(['week#2026-03-31', 'week#2026-04-14', 'week#2025-04-07', 'month#2026-03', 'month#2026-05'])(
    'a GET claiming %s is current writes nothing and returns it empty, like any other period that is not current',
    async (periodKey) => {
      nothingStored();
      const data = await get(periodKey);
      expect(data.rules).toEqual([]);
      expect(data.goals).toEqual([]);
      expect(data.meta.cloned).toBeUndefined();
      expect(ddbMock.commandCalls(BatchWriteCommand)).toHaveLength(0);
    },
  );

  it.each(['week#2026-04-07', 'month#2026-04'])('the period %s that holds today shows its starting rules when claimed, and a GET writes nothing', async (periodKey) => {
    nothingStored();
    const data = await get(periodKey);
    expect(data.meta.cloned).toBe(true);
    expect(data.rules.length).toBeGreaterThan(0);
    expect(ddbMock.commandCalls(BatchWriteCommand)).toHaveLength(0);
  });

  it('materializePeriod stores the current period once, and never a past or an already stored one', async () => {
    nothingStored();
    await materializePeriod('user-1', 'week#2026-04-07');
    expect(ddbMock.commandCalls(BatchWriteCommand).length).toBeGreaterThan(0);
    ddbMock.reset();
    nothingStored();
    await materializePeriod('user-1', 'week#2026-03-31');
    expect(ddbMock.commandCalls(BatchWriteCommand)).toHaveLength(0);
    ddbMock.reset();
    ddbMock.on(QueryCommand).resolves({ Items: [{ userId: 'user-1', ruleId: 'week#2026-04-07#r1', rule: 'x' }] });
    ddbMock.on(BatchWriteCommand).resolves({ UnprocessedItems: {} });
    await materializePeriod('user-1', 'week#2026-04-07');
    expect(ddbMock.commandCalls(BatchWriteCommand)).toHaveLength(0);
  });

  it('a period that holds today is still empty and unwritten when the client does not claim it', async () => {
    nothingStored();
    const data = await get('week#2026-04-07', 'false');
    expect(data.goals).toEqual([]);
    expect(ddbMock.commandCalls(BatchWriteCommand)).toHaveLength(0);
  });

  it('today is the day in the time zone of the user, not in UTC', async () => {
    // 2026-04-13 20:30Z is already Tuesday 2026-04-14 in Kolkata: the new week has started for this user.
    vi.setSystemTime(new Date('2026-04-13T20:30:00Z'));
    ddbMock.on(QueryCommand).resolves({ Items: [] });
    ddbMock.on(GetCommand).resolves({ Item: { userId: 'user-1', carryForwardGoalsRules: false, timeZone: 'Asia/Kolkata' } });
    ddbMock.on(BatchWriteCommand).resolves({ UnprocessedItems: {} });
    expect((await get('week#2026-04-14')).meta.cloned).toBe(true);
    expect((await get('week#2026-04-07')).meta.cloned).toBeUndefined();
  });

  it('records that already exist are returned without the check', async () => {
    ddbMock.on(QueryCommand).resolves({ Items: [{ userId: 'user-1', goalId: 'week#2026-03-31#g', period: 'weekly', goalType: 'profit', target: 1 }] });
    const data = await get('week#2026-03-31');
    expect(data.goals).toHaveLength(1);
    expect(ddbMock.commandCalls(GetCommand)).toHaveLength(0);
  });
});

describe('periodHoldsDay', () => {
  it('a week holds its 7 days from the first one', () => {
    expect(periodHoldsDay('week#2026-04-07', '2026-04-07')).toBe(true);
    expect(periodHoldsDay('week#2026-04-07', '2026-04-13')).toBe(true);
    expect(periodHoldsDay('week#2026-04-07', '2026-04-14')).toBe(false);
    expect(periodHoldsDay('week#2026-04-07', '2026-04-06')).toBe(false);
  });

  it('a month holds its own days only', () => {
    expect(periodHoldsDay('month#2026-04', '2026-04-30')).toBe(true);
    expect(periodHoldsDay('month#2026-04', '2026-05-01')).toBe(false);
    expect(periodHoldsDay('month#2026-04', '2025-04-15')).toBe(false);
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
