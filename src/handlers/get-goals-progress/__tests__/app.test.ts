import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBDocumentClient, QueryCommand } from '@aws-sdk/lib-dynamodb';

// Stub env before importing handler
vi.stubEnv('DAILY_STATS_TABLE', 'test-daily-stats');
vi.stubEnv('GOALS_TABLE', 'test-goals');
vi.stubEnv('RULES_TABLE', 'test-rules');

// Mock DynamoDBDocumentClient (the shared ddb module instantiates at import time)
const ddbMock = mockClient(DynamoDBDocumentClient);

const { handler } = await import('../app.ts');

// ─── Helpers ────────────────────────────────────────────────────────

function makeJwt(sub: string): string {
  const header = btoa(JSON.stringify({ alg: 'RS256' }));
  const payload = btoa(JSON.stringify({ sub }));
  return `${header}.${payload}.sig`;
}

function makeEvent(params: Record<string, string> = {}): any {
  return {
    requestContext: { requestId: 'req-1', authorizer: { jwt: { claims: { sub: 'user-1' } } } },
    queryStringParameters: params,
    headers: { authorization: `Bearer ${makeJwt('user-1')}` },
  };
}

// ─── Mock Data ──────────────────────────────────────────────────────

const mockGoals = [
  { userId: 'user-1', goalId: 'g1', goalType: 'profit', period: 'weekly', target: 500, accountId: 'acc1' },
  { userId: 'user-1', goalId: 'g2', goalType: 'winRate', period: 'weekly', target: 65, accountId: 'acc1' },
  { userId: 'user-1', goalId: 'g3', goalType: 'maxDrawdown', period: 'weekly', target: 3, accountId: 'acc1' },
  { userId: 'user-1', goalId: 'g4', goalType: 'tradeCount', period: 'weekly', target: 8, accountId: 'acc1' },
];

const mockMonthlyGoals = [
  { userId: 'user-1', goalId: 'g5', goalType: 'profit', period: 'monthly', target: 2000, accountId: 'acc1' },
  { userId: 'user-1', goalId: 'g6', goalType: 'winRate', period: 'monthly', target: 70, accountId: 'acc1' },
];

const mockRules = [
  { userId: 'user-1', ruleId: 'r1', rule: 'Never risk more than 1%', isActive: true },
  { userId: 'user-1', ruleId: 'r2', rule: 'Always set stop loss', isActive: true },
  { userId: 'user-1', ruleId: 'r3', rule: 'No news trading', isActive: false },
];

/**
 * Build a mock daily stats record matching the shape produced by computeDailyRecord.
 * `grossLoss` is stored as a positive number.
 */
function makeDailyRecord(overrides: Record<string, any> = {}) {
  return {
    userId: 'user-1',
    sk: 'acc1#2026-04-10',
    accountId: 'acc1',
    date: '2026-04-10',
    dayOfWeek: 5,
    lastUpdated: '2026-04-10T12:00:00Z',
    tradeCount: 3,
    wins: 2,
    losses: 1,
    breakeven: 0,
    grossProfit: 200,
    grossLoss: 50,
    totalPnl: 150,
    totalVolume: 3,
    bestTrade: 120,
    worstTrade: -50,
    pnlSequence: [120, -50, 80],
    brokenRulesCounts: { r1: 1, r2: 2 },
    sumRiskReward: 6.0,
    riskRewardCount: 3,
    totalDurationHours: 6,
    durationTradeCount: 3,
    minDurationHours: 1,
    maxDurationHours: 3,
    durationBuckets: {},
    symbolDistribution: {},
    strategyDistribution: {},
    sessionDistribution: {},
    outcomeDistribution: {},
    hourlyBreakdown: {},
    equityCurvePoints: [],
    ...overrides,
  };
}

/**
 * Setup DDB mock with table-name-based matchers for the 3 parallel queries.
 */
function setupMocks(opts: {
  dailyStats?: any[];
  goals?: any[];
  rules?: any[];
  dailyStatsPages?: Array<{ Items: any[]; LastEvaluatedKey?: any }>;
} = {}) {
  const { dailyStats, goals, rules, dailyStatsPages } = opts;

  if (dailyStatsPages) {
    // Multi-page daily stats
    const chain = ddbMock.on(QueryCommand, { TableName: 'test-daily-stats' });
    for (const page of dailyStatsPages) {
      chain.resolvesOnce(page);
    }
  } else {
    ddbMock.on(QueryCommand, { TableName: 'test-daily-stats' }).resolves({
      Items: dailyStats ?? [],
    });
  }

  ddbMock.on(QueryCommand, { TableName: 'test-goals' }).resolves({
    Items: goals ?? [],
  });

  ddbMock.on(QueryCommand, { TableName: 'test-rules' }).resolves({
    Items: rules ?? [],
  });
}

// ─── Tests ──────────────────────────────────────────────────────────

beforeEach(() => {
  ddbMock.reset();
});

describe('get-goals-progress handler', () => {
  // ── Auth & Validation ──────────────────────────────────────────

  it('returns 401 when no auth', async () => {
    const event = {
      requestContext: { requestId: 'req-1', authorizer: {} },
      queryStringParameters: {
        accountId: 'acc1',
        startDate: '2026-04-06',
        endDate: '2026-04-12',
        period: 'weekly',
      },
      headers: {},
    };

    const res = await handler(event as any);

    expect(res.statusCode).toBe(401);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(false);
  });

  it('returns 400 when missing accountId', async () => {
    const res = await handler(
      makeEvent({ startDate: '2026-04-06', endDate: '2026-04-12', period: 'weekly' }),
    );

    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(false);
    expect(body.message).toContain('accountId');
  });

  it('returns 400 when missing startDate', async () => {
    const res = await handler(
      makeEvent({ accountId: 'acc1', endDate: '2026-04-12', period: 'weekly' }),
    );

    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(false);
    expect(body.message).toContain('startDate');
  });

  it('returns 400 when missing endDate', async () => {
    const res = await handler(
      makeEvent({ accountId: 'acc1', startDate: '2026-04-06', period: 'weekly' }),
    );

    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(false);
    expect(body.message).toContain('endDate');
  });

  it('returns 400 when missing period', async () => {
    const res = await handler(
      makeEvent({ accountId: 'acc1', startDate: '2026-04-06', endDate: '2026-04-12' }),
    );

    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(false);
    expect(body.message).toContain('period');
  });

  it('returns 400 when period is invalid (not weekly/monthly)', async () => {
    const res = await handler(
      makeEvent({ accountId: 'acc1', startDate: '2026-04-06', endDate: '2026-04-12', period: 'daily' }),
    );

    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(false);
    expect(body.message).toContain('weekly');
  });

  // ── Success - Specific Account ─────────────────────────────────

  it('returns goal progress for a specific account', async () => {
    setupMocks({
      dailyStats: [makeDailyRecord()],
      goals: mockGoals,
      rules: mockRules,
    });

    const res = await handler(
      makeEvent({ accountId: 'acc1', startDate: '2026-04-06', endDate: '2026-04-12', period: 'weekly' }),
    );

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(true);
    expect(body.data.goalProgress).toBeDefined();

    // Verify all 4 goal types present
    const gp = body.data.goalProgress;
    expect(gp.profit).toBeDefined();
    expect(gp.winRate).toBeDefined();
    expect(gp.maxDrawdown).toBeDefined();
    expect(gp.tradeCount).toBeDefined();

    // Each goal type has current, target, progress, achieved
    for (const key of ['profit', 'winRate', 'maxDrawdown', 'tradeCount']) {
      expect(gp[key]).toHaveProperty('current');
      expect(gp[key]).toHaveProperty('target');
      expect(gp[key]).toHaveProperty('progress');
      expect(gp[key]).toHaveProperty('achieved');
    }

    // Verify profit.target matches the goal target
    expect(gp.profit.target).toBe(500);

    // Verify ruleCompliance is included
    expect(body.data.ruleCompliance).toBeDefined();
    expect(body.data.ruleCompliance.brokenRulesCounts).toBeDefined();
  });

  it('verifies profit current matches totalPnl from aggregated stats', async () => {
    setupMocks({
      dailyStats: [makeDailyRecord({ grossProfit: 300, grossLoss: 100, totalPnl: 200 })],
      goals: mockGoals,
      rules: mockRules,
    });

    const res = await handler(
      makeEvent({ accountId: 'acc1', startDate: '2026-04-06', endDate: '2026-04-12', period: 'weekly' }),
    );

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    // totalPnl from aggregated stats should be reflected in profit.current
    expect(body.data.goalProgress.profit.current).toBe(200);
  });

  it('verifies inverse goal maxDrawdown achieved when current <= target', async () => {
    // maxDrawdown is inverse: achieved when current <= target
    // With pnlSequence [100] and no capital, drawdown should be 0 which is <= 3 target
    setupMocks({
      dailyStats: [makeDailyRecord({
        pnlSequence: [100],
        totalPnl: 100,
        tradeCount: 1,
        wins: 1,
        losses: 0,
        grossProfit: 100,
        grossLoss: 0,
      })],
      goals: mockGoals,
      rules: mockRules,
    });

    const res = await handler(
      makeEvent({ accountId: 'acc1', startDate: '2026-04-06', endDate: '2026-04-12', period: 'weekly' }),
    );

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    // maxDrawdown target is 3. If current <= 3, achieved = true
    expect(body.data.goalProgress.maxDrawdown.achieved).toBe(true);
  });

  it('verifies inverse goal tradeCount achieved when current <= target', async () => {
    // tradeCount is inverse: achieved when current <= target
    // target is 8, we have 3 trades, so achieved
    setupMocks({
      dailyStats: [makeDailyRecord({ tradeCount: 3 })],
      goals: mockGoals,
      rules: mockRules,
    });

    const res = await handler(
      makeEvent({ accountId: 'acc1', startDate: '2026-04-06', endDate: '2026-04-12', period: 'weekly' }),
    );

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    // 3 trades <= 8 target, so achieved = true
    expect(body.data.goalProgress.tradeCount.current).toBe(3);
    expect(body.data.goalProgress.tradeCount.target).toBe(8);
    expect(body.data.goalProgress.tradeCount.achieved).toBe(true);
  });

  it('verifies non-inverse goal profit not achieved when current < target', async () => {
    // profit target is 500, current is 150 -> not achieved
    setupMocks({
      dailyStats: [makeDailyRecord({ totalPnl: 150, grossProfit: 200, grossLoss: 50 })],
      goals: mockGoals,
      rules: mockRules,
    });

    const res = await handler(
      makeEvent({ accountId: 'acc1', startDate: '2026-04-06', endDate: '2026-04-12', period: 'weekly' }),
    );

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.data.goalProgress.profit.current).toBe(150);
    expect(body.data.goalProgress.profit.target).toBe(500);
    expect(body.data.goalProgress.profit.achieved).toBe(false);
    expect(body.data.goalProgress.profit.progress).toBe(30); // 150/500 * 100
  });

  // ── Success - ALL Accounts ─────────────────────────────────────

  it('returns aggregated goal progress for ALL accounts', async () => {
    const record1 = makeDailyRecord({
      accountId: 'acc1',
      sk: 'acc1#2026-04-10',
      tradeCount: 2,
      wins: 1,
      losses: 1,
      grossProfit: 100,
      grossLoss: 40,
      totalPnl: 60,
    });
    const record2 = makeDailyRecord({
      accountId: 'acc2',
      sk: 'acc2#2026-04-10',
      tradeCount: 1,
      wins: 1,
      losses: 0,
      grossProfit: 80,
      grossLoss: 0,
      totalPnl: 80,
      brokenRulesCounts: {},
      pnlSequence: [80],
    });

    // Goals from multiple accounts with same goalType
    const allGoals = [
      { userId: 'user-1', goalId: 'g1', goalType: 'profit', period: 'weekly', target: 300, accountId: 'acc1' },
      { userId: 'user-1', goalId: 'g2', goalType: 'profit', period: 'weekly', target: 200, accountId: 'acc2' },
    ];

    setupMocks({
      dailyStats: [record1, record2],
      goals: allGoals,
      rules: mockRules,
    });

    const res = await handler(
      makeEvent({ accountId: 'ALL', startDate: '2026-04-06', endDate: '2026-04-12', period: 'weekly' }),
    );

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(true);

    // For ALL accounts, targets should be summed (300 + 200 = 500)
    expect(body.data.goalProgress.profit.target).toBe(500);

    // Verify GSI query was used for daily stats
    const dailyStatsCalls = ddbMock.commandCalls(QueryCommand).filter(
      (c) => c.args[0].input.TableName === 'test-daily-stats',
    );
    expect(dailyStatsCalls.length).toBeGreaterThanOrEqual(1);
    expect(dailyStatsCalls[0].args[0].input.IndexName).toBe('stats-by-date-gsi');
  });

  // ── Empty Results ──────────────────────────────────────────────

  it('returns zero progress when no daily stats records exist', async () => {
    setupMocks({
      dailyStats: [],
      goals: mockGoals,
      rules: mockRules,
    });

    const res = await handler(
      makeEvent({ accountId: 'acc1', startDate: '2026-04-06', endDate: '2026-04-12', period: 'weekly' }),
    );

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(true);

    // With no stats, all progress should be zero
    expect(body.data.goalProgress.profit.current).toBe(0);
    expect(body.data.goalProgress.profit.progress).toBe(0);
    expect(body.data.goalProgress.winRate.current).toBe(0);
    expect(body.data.goalProgress.tradeCount.current).toBe(0);
  });

  it('returns zero progress when no goals exist for the period', async () => {
    setupMocks({
      dailyStats: [makeDailyRecord()],
      goals: [], // no goals at all
      rules: mockRules,
    });

    const res = await handler(
      makeEvent({ accountId: 'acc1', startDate: '2026-04-06', endDate: '2026-04-12', period: 'weekly' }),
    );

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(true);

    // All targets should be 0 since no goals exist
    expect(body.data.goalProgress.profit.target).toBe(0);
    expect(body.data.goalProgress.winRate.target).toBe(0);
    expect(body.data.goalProgress.maxDrawdown.target).toBe(0);
    expect(body.data.goalProgress.tradeCount.target).toBe(0);
  });

  it('returns empty brokenRulesCounts when no rules are broken', async () => {
    setupMocks({
      dailyStats: [makeDailyRecord({ brokenRulesCounts: {} })],
      goals: mockGoals,
      rules: mockRules,
    });

    const res = await handler(
      makeEvent({ accountId: 'acc1', startDate: '2026-04-06', endDate: '2026-04-12', period: 'weekly' }),
    );

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.data.ruleCompliance.brokenRulesCounts).toEqual({});
  });

  // ── Rule Compliance ────────────────────────────────────────────

  it('all rules followed means followedCount equals totalActiveRules', async () => {
    // No broken rules in the daily record
    setupMocks({
      dailyStats: [makeDailyRecord({ brokenRulesCounts: {} })],
      goals: mockGoals,
      rules: mockRules,
    });

    const res = await handler(
      makeEvent({ accountId: 'acc1', startDate: '2026-04-06', endDate: '2026-04-12', period: 'weekly' }),
    );

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    const rc = body.data.ruleCompliance;

    // 2 active rules (r1, r2), r3 is inactive
    expect(rc.totalActiveRules).toBe(2);
    expect(rc.followedCount).toBe(2);
    expect(rc.brokenCount).toBe(0);
    expect(rc.complianceRate).toBe(100);
  });

  it('some rules broken means followedCount excludes broken rules', async () => {
    // r1 broken 1 time, r2 broken 2 times
    setupMocks({
      dailyStats: [makeDailyRecord({ brokenRulesCounts: { r1: 1, r2: 2 } })],
      goals: mockGoals,
      rules: mockRules,
    });

    const res = await handler(
      makeEvent({ accountId: 'acc1', startDate: '2026-04-06', endDate: '2026-04-12', period: 'weekly' }),
    );

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    const rc = body.data.ruleCompliance;

    // Both r1 and r2 are active and broken, so followedCount = 0
    expect(rc.totalActiveRules).toBe(2);
    expect(rc.followedCount).toBe(0);
    expect(rc.brokenCount).toBe(2);
    expect(rc.complianceRate).toBe(0);
  });

  it('inactive rules excluded from totalActiveRules count', async () => {
    // All rules are inactive
    const inactiveRules = [
      { userId: 'user-1', ruleId: 'r1', rule: 'Rule 1', isActive: false },
      { userId: 'user-1', ruleId: 'r2', rule: 'Rule 2', isActive: false },
    ];

    setupMocks({
      dailyStats: [makeDailyRecord({ brokenRulesCounts: { r1: 1 } })],
      goals: mockGoals,
      rules: inactiveRules,
    });

    const res = await handler(
      makeEvent({ accountId: 'acc1', startDate: '2026-04-06', endDate: '2026-04-12', period: 'weekly' }),
    );

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    const rc = body.data.ruleCompliance;

    expect(rc.totalActiveRules).toBe(0);
    // When no active rules, complianceRate should be 100
    expect(rc.complianceRate).toBe(100);
  });

  it('DailyStats missing brokenRulesCounts is treated as empty', async () => {
    setupMocks({
      dailyStats: [makeDailyRecord({ brokenRulesCounts: undefined })],
      goals: mockGoals,
      rules: mockRules,
    });

    const res = await handler(
      makeEvent({ accountId: 'acc1', startDate: '2026-04-06', endDate: '2026-04-12', period: 'weekly' }),
    );

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    const rc = body.data.ruleCompliance;

    // Both rules should be followed since no brokenRulesCounts
    expect(rc.followedCount).toBe(2);
    expect(rc.brokenCount).toBe(0);
  });

  // ── Error Handling ─────────────────────────────────────────────

  it('returns 500 when DynamoDB query fails', async () => {
    ddbMock.on(QueryCommand).rejects(new Error('DynamoDB timeout'));

    const res = await handler(
      makeEvent({ accountId: 'acc1', startDate: '2026-04-06', endDate: '2026-04-12', period: 'weekly' }),
    );

    expect(res.statusCode).toBe(500);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(false);
    expect(body.errorCode).toBe('INTERNAL_ERROR');
  });

  it('returns correct data when pagination needed (LastEvaluatedKey)', async () => {
    const record1 = makeDailyRecord({
      date: '2026-04-08',
      sk: 'acc1#2026-04-08',
      tradeCount: 2,
      wins: 1,
      losses: 1,
      grossProfit: 100,
      grossLoss: 30,
      totalPnl: 70,
      pnlSequence: [100, -30],
    });
    const record2 = makeDailyRecord({
      date: '2026-04-09',
      sk: 'acc1#2026-04-09',
      dayOfWeek: 4,
      tradeCount: 1,
      wins: 1,
      losses: 0,
      grossProfit: 50,
      grossLoss: 0,
      totalPnl: 50,
      pnlSequence: [50],
      brokenRulesCounts: {},
    });

    setupMocks({
      dailyStatsPages: [
        { Items: [record1], LastEvaluatedKey: { userId: 'user-1', sk: 'acc1#2026-04-08' } },
        { Items: [record2] },
      ],
      goals: mockGoals,
      rules: mockRules,
    });

    const res = await handler(
      makeEvent({ accountId: 'acc1', startDate: '2026-04-06', endDate: '2026-04-12', period: 'weekly' }),
    );

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(true);

    // Should have aggregated both pages: tradeCount 2 + 1 = 3
    expect(body.data.goalProgress.tradeCount.current).toBe(3);

    // Verify two query calls were made for daily stats
    const dailyStatsCalls = ddbMock.commandCalls(QueryCommand).filter(
      (c) => c.args[0].input.TableName === 'test-daily-stats',
    );
    expect(dailyStatsCalls).toHaveLength(2);
    expect(dailyStatsCalls[1].args[0].input.ExclusiveStartKey).toBeDefined();
  });

  // ── Period Filtering ───────────────────────────────────────────

  it('only returns goals matching requested period (weekly goals for weekly period)', async () => {
    // Include both weekly and monthly goals
    const allGoals = [...mockGoals, ...mockMonthlyGoals];

    setupMocks({
      dailyStats: [makeDailyRecord()],
      goals: allGoals,
      rules: mockRules,
    });

    const res = await handler(
      makeEvent({ accountId: 'acc1', startDate: '2026-04-06', endDate: '2026-04-12', period: 'weekly' }),
    );

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);

    // The filtered goals should only contain weekly goals
    const returnedGoals = body.data.goals;
    expect(returnedGoals.length).toBe(4); // 4 weekly goals
    for (const g of returnedGoals) {
      expect(g.period).toBe('weekly');
    }
  });

  it('monthly goals not included when period=weekly', async () => {
    // Only monthly goals in the DB
    setupMocks({
      dailyStats: [makeDailyRecord()],
      goals: mockMonthlyGoals,
      rules: mockRules,
    });

    const res = await handler(
      makeEvent({ accountId: 'acc1', startDate: '2026-04-06', endDate: '2026-04-12', period: 'weekly' }),
    );

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);

    // No weekly goals, so filteredGoals should be empty
    expect(body.data.goals).toHaveLength(0);
    // All targets should be 0
    expect(body.data.goalProgress.profit.target).toBe(0);
    expect(body.data.goalProgress.winRate.target).toBe(0);
  });

  // ── Additional Edge Cases ──────────────────────────────────────

  it('only rules broken with count > 0 affect compliance', async () => {
    // r1 broken 1 time, r2 has 0 count (edge case: zero count should not count as broken)
    setupMocks({
      dailyStats: [makeDailyRecord({ brokenRulesCounts: { r1: 1, r2: 0 } })],
      goals: mockGoals,
      rules: mockRules,
    });

    const res = await handler(
      makeEvent({ accountId: 'acc1', startDate: '2026-04-06', endDate: '2026-04-12', period: 'weekly' }),
    );

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    const rc = body.data.ruleCompliance;

    // r1 is broken (count > 0), r2 is not (count = 0)
    expect(rc.followedCount).toBe(1);
    expect(rc.brokenCount).toBe(1);
  });

  it('response includes success message', async () => {
    setupMocks({
      dailyStats: [makeDailyRecord()],
      goals: mockGoals,
      rules: mockRules,
    });

    const res = await handler(
      makeEvent({ accountId: 'acc1', startDate: '2026-04-06', endDate: '2026-04-12', period: 'weekly' }),
    );

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.message).toBe('Goals progress retrieved successfully');
  });

  it('response includes rules in the data', async () => {
    setupMocks({
      dailyStats: [makeDailyRecord()],
      goals: mockGoals,
      rules: mockRules,
    });

    const res = await handler(
      makeEvent({ accountId: 'acc1', startDate: '2026-04-06', endDate: '2026-04-12', period: 'weekly' }),
    );

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.data.rules).toHaveLength(3);
    expect(body.data.rules[0].ruleId).toBe('r1');
  });

  it('correctly filters goals for a specific accountId', async () => {
    // Mix of acc1 and acc2 goals
    const mixedGoals = [
      { userId: 'user-1', goalId: 'g1', goalType: 'profit', period: 'weekly', target: 500, accountId: 'acc1' },
      { userId: 'user-1', goalId: 'g2', goalType: 'profit', period: 'weekly', target: 300, accountId: 'acc2' },
      { userId: 'user-1', goalId: 'g3', goalType: 'winRate', period: 'weekly', target: 65, accountId: 'acc1' },
    ];

    setupMocks({
      dailyStats: [makeDailyRecord()],
      goals: mixedGoals,
      rules: mockRules,
    });

    const res = await handler(
      makeEvent({ accountId: 'acc1', startDate: '2026-04-06', endDate: '2026-04-12', period: 'weekly' }),
    );

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);

    // Only acc1 goals should be returned
    expect(body.data.goals).toHaveLength(2);
    for (const g of body.data.goals) {
      expect(g.accountId).toBe('acc1');
    }
    // Profit target should be 500 (from acc1 only, not 800)
    expect(body.data.goalProgress.profit.target).toBe(500);
  });

  it('complianceRate is correctly computed as a percentage', async () => {
    // 3 active rules, 1 broken -> followedCount = 2, rate = 66.67
    const threeActiveRules = [
      { userId: 'user-1', ruleId: 'r1', rule: 'Rule 1', isActive: true },
      { userId: 'user-1', ruleId: 'r2', rule: 'Rule 2', isActive: true },
      { userId: 'user-1', ruleId: 'r3', rule: 'Rule 3', isActive: true },
    ];

    setupMocks({
      dailyStats: [makeDailyRecord({ brokenRulesCounts: { r1: 1 } })],
      goals: mockGoals,
      rules: threeActiveRules,
    });

    const res = await handler(
      makeEvent({ accountId: 'acc1', startDate: '2026-04-06', endDate: '2026-04-12', period: 'weekly' }),
    );

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    const rc = body.data.ruleCompliance;

    expect(rc.totalActiveRules).toBe(3);
    expect(rc.followedCount).toBe(2);
    expect(rc.brokenCount).toBe(1);
    // 2/3 * 100 = 66.67 (rounded to 2 decimal places)
    expect(rc.complianceRate).toBe(66.67);
  });

  it('uses main table query for specific account (not GSI)', async () => {
    setupMocks({
      dailyStats: [makeDailyRecord()],
      goals: mockGoals,
      rules: mockRules,
    });

    const res = await handler(
      makeEvent({ accountId: 'acc1', startDate: '2026-04-06', endDate: '2026-04-12', period: 'weekly' }),
    );

    expect(res.statusCode).toBe(200);

    const dailyStatsCalls = ddbMock.commandCalls(QueryCommand).filter(
      (c) => c.args[0].input.TableName === 'test-daily-stats',
    );
    expect(dailyStatsCalls.length).toBeGreaterThanOrEqual(1);
    // Specific account should NOT use IndexName
    expect(dailyStatsCalls[0].args[0].input.IndexName).toBeUndefined();
    // Should use sk BETWEEN
    expect(dailyStatsCalls[0].args[0].input.KeyConditionExpression).toContain('sk BETWEEN');
  });

  it('uses GSI query for ALL accounts', async () => {
    setupMocks({
      dailyStats: [makeDailyRecord()],
      goals: mockGoals,
      rules: mockRules,
    });

    const res = await handler(
      makeEvent({ accountId: 'ALL', startDate: '2026-04-06', endDate: '2026-04-12', period: 'weekly' }),
    );

    expect(res.statusCode).toBe(200);

    const dailyStatsCalls = ddbMock.commandCalls(QueryCommand).filter(
      (c) => c.args[0].input.TableName === 'test-daily-stats',
    );
    expect(dailyStatsCalls.length).toBeGreaterThanOrEqual(1);
    expect(dailyStatsCalls[0].args[0].input.IndexName).toBe('stats-by-date-gsi');
  });
});
