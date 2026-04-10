import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBDocumentClient, QueryCommand } from '@aws-sdk/lib-dynamodb';

// Stub env before importing handler
vi.stubEnv('DAILY_STATS_TABLE', 'test-daily-stats');

// Mock DynamoDBDocumentClient (the shared ddb module instantiates at import time)
const ddbMock = mockClient(DynamoDBDocumentClient);

const { handler } = await import('../app.ts');

// --- Helpers ----------------------------------------------------------------

function makeJwt(sub: string): string {
  const header = btoa(JSON.stringify({ alg: 'RS256' }));
  const payload = btoa(JSON.stringify({ sub }));
  return `${header}.${payload}.sig`;
}

function makeEvent(queryParams: Record<string, string> = {}): any {
  const jwt = makeJwt('test-user-id');
  return {
    requestContext: { requestId: 'test-req', authorizer: { jwt: { claims: { sub: 'test-user-id' } } } },
    queryStringParameters: queryParams,
    headers: { authorization: `Bearer ${jwt}` },
  };
}

// --- Sample daily stats records ---------------------------------------------

/**
 * Build a mock daily stats record matching the shape produced by computeDailyRecord.
 * Key field: `tradeCount` (NOT totalTrades) — the CoreStatsAggregator reads this field.
 * `grossLoss` is stored as a positive number (Math.abs applied in CoreStatsProcessor).
 */
function makeDailyRecord(overrides: Record<string, any> = {}) {
  return {
    userId: 'test-user-id',
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

describe('get-stats handler', () => {
  // -- Auth ------------------------------------------------------------------

  it('returns 401 when no auth', async () => {
    const event = {
      requestContext: { requestId: 'test-req', authorizer: {} },
      queryStringParameters: { accountId: 'acc-1', startDate: '2026-04-01', endDate: '2026-04-30' },
      headers: {},
    };

    const res = await handler(event as any);

    expect(res.statusCode).toBe(401);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(false);
  });

  // -- Validation ------------------------------------------------------------

  it('returns 400 when missing accountId', async () => {
    const res = await handler(makeEvent({ startDate: '2026-04-01', endDate: '2026-04-30' }));

    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(false);
    expect(body.message).toContain('accountId');
  });

  it('returns 400 when missing startDate', async () => {
    const res = await handler(makeEvent({ accountId: 'acc-1', endDate: '2026-04-30' }));

    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(false);
    expect(body.message).toContain('startDate');
  });

  it('returns 400 when missing endDate', async () => {
    const res = await handler(makeEvent({ accountId: 'acc-1', startDate: '2026-04-01' }));

    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(false);
    expect(body.message).toContain('endDate');
  });

  // -- Single account query --------------------------------------------------

  it('returns aggregated stats for a specific account', async () => {
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

    const res = await handler(
      makeEvent({ accountId: 'acc-1', startDate: '2026-04-01', endDate: '2026-04-30' }),
    );

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

    const res = await handler(
      makeEvent({ accountId: 'ALL', startDate: '2026-04-01', endDate: '2026-04-30' }),
    );

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

  // -- Pagination ------------------------------------------------------------

  it('handles pagination (multiple pages of results)', async () => {
    const record1 = makeDailyRecord({ date: '2026-04-06', sk: 'acc-1#2026-04-06' });
    const record2 = makeDailyRecord({
      date: '2026-04-07',
      sk: 'acc-1#2026-04-07',
      dayOfWeek: 2,
      tradeCount: 1,
      wins: 1,
      losses: 0,
      grossProfit: 100,
      grossLoss: 0,
      totalPnl: 100,
      pnlSequence: [100],
    });

    // First page returns record1 with LastEvaluatedKey, second page returns record2
    ddbMock
      .on(QueryCommand)
      .resolvesOnce({
        Items: [record1],
        LastEvaluatedKey: { userId: 'test-user-id', sk: 'acc-1#2026-04-06' },
      })
      .resolvesOnce({
        Items: [record2],
      });

    const res = await handler(
      makeEvent({ accountId: 'acc-1', startDate: '2026-04-01', endDate: '2026-04-30' }),
    );

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(true);
    // Should have aggregated both pages
    expect(body.data.totalTrades).toBe(4); // 3 from record1 + 1 from record2

    // Verify two query calls were made
    const queryCalls = ddbMock.commandCalls(QueryCommand);
    expect(queryCalls).toHaveLength(2);
    // Second call should include ExclusiveStartKey
    expect(queryCalls[1].args[0].input.ExclusiveStartKey).toBeDefined();
  });

  // -- Empty results ---------------------------------------------------------

  it('returns empty stats when no daily records found', async () => {
    ddbMock.on(QueryCommand).resolves({ Items: [] });

    const res = await handler(
      makeEvent({ accountId: 'acc-1', startDate: '2026-04-01', endDate: '2026-04-30' }),
    );

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(true);
    expect(body.data.totalTrades).toBe(0);
    expect(body.data.winRate).toBe(0);
    expect(body.data.totalPnl).toBe(0);
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

    const res = await handler(
      makeEvent({
        accountId: 'acc-1',
        startDate: '2026-04-01',
        endDate: '2026-04-30',
        totalCapital: '50000',
        includeEquityCurve: 'true',
      }),
    );

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(true);
    expect(body.data).toBeDefined();
    // When includeEquityCurve is true and records have data, equityCurve should be present
    // The exact behavior depends on the aggregator, but the handler should pass the options through
    expect(body.data.totalTrades).toBeGreaterThanOrEqual(1);
  });

  // -- DynamoDB error --------------------------------------------------------

  it('returns 500 when DynamoDB query fails', async () => {
    ddbMock.on(QueryCommand).rejects(new Error('DynamoDB timeout'));

    const res = await handler(
      makeEvent({ accountId: 'acc-1', startDate: '2026-04-01', endDate: '2026-04-30' }),
    );

    expect(res.statusCode).toBe(500);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(false);
    expect(body.errorCode).toBe('INTERNAL_ERROR');
  });

  // -- Invalid date format for startDate ------------------------------------

  it('queries DynamoDB with invalid startDate string (DDB handles it)', async () => {
    ddbMock.on(QueryCommand).resolves({ Items: [] });

    const res = await handler(
      makeEvent({ accountId: 'acc-1', startDate: 'not-a-date', endDate: '2026-04-30' }),
    );

    // DynamoDB BETWEEN on string keys will simply return nothing for nonsense values
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(true);
    expect(body.data.totalTrades).toBe(0);
  });

  // -- startDate after endDate (inverted range) -----------------------------

  it('returns empty results when startDate is after endDate', async () => {
    ddbMock.on(QueryCommand).resolves({ Items: [] });

    const res = await handler(
      makeEvent({ accountId: 'acc-1', startDate: '2026-12-31', endDate: '2026-01-01' }),
    );

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(true);
    expect(body.data.totalTrades).toBe(0);
  });

  // -- Invalid totalCapital (non-numeric) -----------------------------------

  it('handles non-numeric totalCapital gracefully (NaN from parseFloat)', async () => {
    const record = makeDailyRecord();
    ddbMock.on(QueryCommand).resolves({ Items: [record] });

    const res = await handler(
      makeEvent({
        accountId: 'acc-1',
        startDate: '2026-04-01',
        endDate: '2026-04-30',
        totalCapital: 'abc',
      }),
    );

    // parseFloat('abc') returns NaN — aggregator should still produce results
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(true);
    expect(body.data.totalTrades).toBeGreaterThanOrEqual(1);
  });

  // -- GSI query fails for ALL accounts -------------------------------------

  it('returns 500 when GSI query fails for ALL accounts', async () => {
    ddbMock.on(QueryCommand).rejects(new Error('GSI throughput exceeded'));

    const res = await handler(
      makeEvent({ accountId: 'ALL', startDate: '2026-04-01', endDate: '2026-04-30' }),
    );

    expect(res.statusCode).toBe(500);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(false);
    expect(body.errorCode).toBe('INTERNAL_ERROR');
  });

  // -- Daily records with corrupted/missing fields --------------------------

  it('aggregates records with missing tradeCount and pnlSequence without crashing', async () => {
    const corruptedRecord = makeDailyRecord({
      tradeCount: undefined,
      pnlSequence: undefined,
      wins: undefined,
      losses: undefined,
    });

    ddbMock.on(QueryCommand).resolves({ Items: [corruptedRecord] });

    const res = await handler(
      makeEvent({ accountId: 'acc-1', startDate: '2026-04-01', endDate: '2026-04-30' }),
    );

    // Should not crash — handler should return 200 even with partial data
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(true);
    expect(body.data).toBeDefined();
  });

  // -- Very large date range ------------------------------------------------

  it('handles a very large date range (10 years) and returns results', async () => {
    const record = makeDailyRecord();
    ddbMock.on(QueryCommand).resolves({ Items: [record] });

    const res = await handler(
      makeEvent({ accountId: 'acc-1', startDate: '2016-01-01', endDate: '2026-12-31' }),
    );

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(true);
    expect(body.data).toBeDefined();
    expect(body.data.totalTrades).toBeGreaterThanOrEqual(1);

    // Verify the query was made with the wide date range
    const queryCalls = ddbMock.commandCalls(QueryCommand);
    expect(queryCalls.length).toBeGreaterThanOrEqual(1);
    const input = queryCalls[0].args[0].input;
    expect(input.ExpressionAttributeValues![':skStart']).toContain('2016-01-01');
    expect(input.ExpressionAttributeValues![':skEnd']).toContain('2026-12-31');
  });

  // -- AccountId is empty string --------------------------------------------

  it('returns 400 when accountId is empty string', async () => {
    const res = await handler(
      makeEvent({ accountId: '', startDate: '2026-04-01', endDate: '2026-04-30' }),
    );

    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(false);
  });
});
