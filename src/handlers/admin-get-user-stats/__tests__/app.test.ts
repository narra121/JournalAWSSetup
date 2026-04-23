import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBDocumentClient, QueryCommand } from '@aws-sdk/lib-dynamodb';

// Stub env before importing handler
vi.stubEnv('DAILY_STATS_TABLE', 'test-daily-stats');

// Mock DynamoDBDocumentClient (the shared ddb module instantiates at import time)
const ddbMock = mockClient(DynamoDBDocumentClient);

const { handler } = await import('../app.ts');

// --- Helpers ----------------------------------------------------------------

function makeEvent(
  userId: string | undefined,
  queryParams: Record<string, string> = {},
): any {
  return {
    requestContext: { requestId: 'test-req' },
    pathParameters: userId ? { userId } : {},
    queryStringParameters: queryParams,
    headers: {},
  };
}

// --- Sample daily stats records ---------------------------------------------

function makeDailyRecord(overrides: Record<string, any> = {}) {
  return {
    userId: 'target-user-id',
    sk: 'acc-1#2026-04-06',
    accountId: 'acc-1',
    date: '2026-04-06',
    dayOfWeek: 1,
    lastUpdated: '2026-04-06T12:00:00Z',
    tradeCount: 3,
    wins: 2,
    losses: 1,
    breakeven: 0,
    grossProfit: 500,
    grossLoss: 100,
    totalPnl: 400,
    totalVolume: 30,
    bestTrade: 300,
    worstTrade: -100,
    pnlSequence: [300, 200, -100],
    ...overrides,
  };
}

// --- Tests ------------------------------------------------------------------

beforeEach(() => {
  ddbMock.reset();
});

describe('admin-get-user-stats handler', () => {
  // -- Validation: missing userId --------------------------------------------

  it('returns 400 when userId path parameter is missing', async () => {
    const res = await handler(makeEvent(undefined, {
      accountId: 'acc-1',
      startDate: '2026-04-01',
      endDate: '2026-04-30',
    }));

    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(false);
    expect(body.message).toContain('userId');
  });

  it('returns 400 when pathParameters is null', async () => {
    const event = {
      requestContext: { requestId: 'test-req' },
      pathParameters: null,
      queryStringParameters: { accountId: 'acc-1', startDate: '2026-04-01', endDate: '2026-04-30' },
      headers: {},
    };

    const res = await handler(event as any);

    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(false);
    expect(body.message).toContain('userId');
  });

  // -- Validation: missing query params --------------------------------------

  it('returns 400 when missing accountId', async () => {
    const res = await handler(makeEvent('target-user-id', {
      startDate: '2026-04-01',
      endDate: '2026-04-30',
    }));

    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(false);
    expect(body.message).toContain('accountId');
  });

  it('returns 400 when missing startDate', async () => {
    const res = await handler(makeEvent('target-user-id', {
      accountId: 'acc-1',
      endDate: '2026-04-30',
    }));

    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(false);
    expect(body.message).toContain('startDate');
  });

  it('returns 400 when missing endDate', async () => {
    const res = await handler(makeEvent('target-user-id', {
      accountId: 'acc-1',
      startDate: '2026-04-01',
    }));

    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(false);
    expect(body.message).toContain('endDate');
  });

  // -- Single account query --------------------------------------------------

  it('returns 200 with aggregated stats for a specific account', async () => {
    const record1 = makeDailyRecord({
      date: '2026-04-06',
      sk: 'acc-1#2026-04-06',
      tradeCount: 3,
      wins: 2,
      losses: 1,
      grossProfit: 500,
      grossLoss: 100,
      totalPnl: 400,
    });
    const record2 = makeDailyRecord({
      date: '2026-04-07',
      sk: 'acc-1#2026-04-07',
      dayOfWeek: 2,
      tradeCount: 2,
      wins: 1,
      losses: 1,
      grossProfit: 200,
      grossLoss: 150,
      totalPnl: 50,
      bestTrade: 200,
      worstTrade: -150,
      pnlSequence: [200, -150],
    });

    ddbMock.on(QueryCommand).resolves({ Items: [record1, record2] });

    const res = await handler(makeEvent('target-user-id', {
      accountId: 'acc-1',
      startDate: '2026-04-01',
      endDate: '2026-04-30',
    }));

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(true);
    expect(body.data).toBeDefined();
    expect(body.data.totalTrades).toBe(5);
    expect(typeof body.data.winRate).toBe('number');
    expect(typeof body.data.totalPnl).toBe('number');

    // Verify single-account query uses main table (sk BETWEEN)
    const queryCalls = ddbMock.commandCalls(QueryCommand);
    expect(queryCalls.length).toBeGreaterThanOrEqual(1);
    const input = queryCalls[0].args[0].input;
    expect(input.TableName).toBe('test-daily-stats');
    expect(input.KeyConditionExpression).toContain('sk BETWEEN');
    expect(input.IndexName).toBeUndefined();

    // Verify it queries for the target user, not a JWT user
    expect(input.ExpressionAttributeValues![':userId']).toBe('target-user-id');
  });

  // -- ALL accounts (GSI query) ----------------------------------------------

  it('returns aggregated stats for ALL accounts using GSI', async () => {
    const record1 = makeDailyRecord({
      accountId: 'acc-1',
      sk: 'acc-1#2026-04-06',
    });
    const record2 = makeDailyRecord({
      accountId: 'acc-2',
      sk: 'acc-2#2026-04-06',
      tradeCount: 1,
      wins: 0,
      losses: 1,
      grossProfit: 0,
      grossLoss: 50,
      totalPnl: -50,
      bestTrade: 0,
      worstTrade: -50,
      pnlSequence: [-50],
    });

    ddbMock.on(QueryCommand).resolves({ Items: [record1, record2] });

    const res = await handler(makeEvent('target-user-id', {
      accountId: 'ALL',
      startDate: '2026-04-01',
      endDate: '2026-04-30',
    }));

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(true);
    expect(body.data).toBeDefined();
    expect(body.data.totalTrades).toBeGreaterThanOrEqual(1);

    // Verify ALL-accounts query uses GSI
    const queryCalls = ddbMock.commandCalls(QueryCommand);
    expect(queryCalls.length).toBeGreaterThanOrEqual(1);
    const input = queryCalls[0].args[0].input;
    expect(input.IndexName).toBe('stats-by-date-gsi');
    expect(input.KeyConditionExpression).toContain('userId = :userId');
    expect(input.KeyConditionExpression).toContain('BETWEEN');
  });

  // -- Empty results ---------------------------------------------------------

  it('returns empty stats when no daily records found', async () => {
    ddbMock.on(QueryCommand).resolves({ Items: [] });

    const res = await handler(makeEvent('target-user-id', {
      accountId: 'acc-1',
      startDate: '2026-04-01',
      endDate: '2026-04-30',
    }));

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(true);
    expect(body.data.totalTrades).toBe(0);
    expect(body.data.winRate).toBe(0);
    expect(body.data.totalPnl).toBe(0);
  });

  // -- dailyTradeHashes in response ------------------------------------------

  it('includes dailyTradeHashes in response when records have tradeHash', async () => {
    const record = makeDailyRecord({ tradeHash: 'abc123def456' });
    ddbMock.on(QueryCommand).resolves({ Items: [record] });

    const res = await handler(makeEvent('target-user-id', {
      accountId: 'acc-1',
      startDate: '2026-04-01',
      endDate: '2026-04-30',
    }));

    const body = JSON.parse(res.body);
    expect(body.data.dailyTradeHashes).toBeDefined();
    expect(body.data.dailyTradeHashes['acc-1#2026-04-06']).toBe('abc123def456');
  });

  // -- DynamoDB error --------------------------------------------------------

  it('returns 500 when DynamoDB query fails', async () => {
    ddbMock.on(QueryCommand).rejects(new Error('DynamoDB timeout'));

    const res = await handler(makeEvent('target-user-id', {
      accountId: 'acc-1',
      startDate: '2026-04-01',
      endDate: '2026-04-30',
    }));

    expect(res.statusCode).toBe(500);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(false);
    expect(body.errorCode).toBe('INTERNAL_ERROR');
  });

  // -- Options pass-through --------------------------------------------------

  it('passes totalCapital and includeEquityCurve to aggregation', async () => {
    const record = makeDailyRecord({
      tradeCount: 3,
      wins: 2,
      losses: 1,
      grossProfit: 500,
      grossLoss: 100,
      pnlSequence: [300, -100, 200],
      totalPnl: 400,
    });

    ddbMock.on(QueryCommand).resolves({ Items: [record] });

    const res = await handler(makeEvent('target-user-id', {
      accountId: 'acc-1',
      startDate: '2026-04-01',
      endDate: '2026-04-30',
      totalCapital: '50000',
      includeEquityCurve: 'true',
    }));

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(true);
    expect(body.data.totalTrades).toBeGreaterThanOrEqual(1);
  });
});
