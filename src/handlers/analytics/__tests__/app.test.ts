import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBDocumentClient, QueryCommand } from '@aws-sdk/lib-dynamodb';
import type { APIGatewayProxyEvent } from 'aws-lambda';

// Mock environment variables before importing handler
vi.stubEnv('DAILY_STATS_TABLE', 'test-daily-stats');

// Must import handler after env stubs
const { handler } = await import('../app.ts');

const ddbMock = mockClient(DynamoDBDocumentClient);

// --- Helpers ----------------------------------------------------------------

function makeJwt(sub: string): string {
  const header = btoa(JSON.stringify({ alg: 'RS256' }));
  const payload = btoa(JSON.stringify({ sub }));
  return `${header}.${payload}.sig`;
}

function makeEvent(overrides: Partial<APIGatewayProxyEvent> = {}): APIGatewayProxyEvent {
  return {
    httpMethod: 'GET',
    path: '/analytics',
    resource: '/analytics',
    headers: {
      authorization: `Bearer ${makeJwt('user-1')}`,
    },
    multiValueHeaders: {},
    queryStringParameters: { type: 'hourly' },
    multiValueQueryStringParameters: null,
    pathParameters: null,
    stageVariables: null,
    requestContext: {
      accountId: '123',
      apiId: 'api',
      authorizer: {},
      protocol: 'HTTP/1.1',
      httpMethod: 'GET',
      identity: {
        accessKey: null, accountId: null, apiKey: null, apiKeyId: null,
        caller: null, clientCert: null, cognitoAuthenticationProvider: null,
        cognitoAuthenticationType: null, cognitoIdentityId: null,
        cognitoIdentityPoolId: null, principalOrgId: null, sourceIp: '127.0.0.1',
        user: null, userAgent: 'test', userArn: null,
      },
      path: '/analytics',
      stage: 'prod',
      requestId: 'req-1',
      requestTimeEpoch: 0,
      resourceId: 'res-1',
      resourcePath: '/analytics',
    },
    body: null,
    isBase64Encoded: false,
    ...overrides,
  } as APIGatewayProxyEvent;
}

// --- Sample DailyStats records (pre-aggregated) ----------------------------

const sampleDailyRecords = [
  {
    userId: 'user-1',
    sk: 'acc-1#2024-03-15',
    accountId: 'acc-1',
    date: '2024-03-15',
    dayOfWeek: 5, // Friday
    tradeCount: 2,
    wins: 1,
    losses: 1,
    breakeven: 0,
    grossProfit: 500,
    grossLoss: 200,
    totalPnl: 300,
    totalVolume: 2,
    bestTrade: 500,
    worstTrade: -200,
    sumRiskReward: 2.5,
    riskRewardCount: 2,
    pnlSequence: [500, -200],
    symbolDistribution: {
      AAPL: { count: 2, wins: 1, pnl: 300 },
    },
    strategyDistribution: {
      Breakout: { count: 2, wins: 1, pnl: 300 },
    },
    sessionDistribution: {},
    outcomeDistribution: { TP: 1, SL: 1 },
    hourlyBreakdown: {
      '09': { count: 2, wins: 1, pnl: 300 },
    },
  },
  {
    userId: 'user-1',
    sk: 'acc-2#2024-03-16',
    accountId: 'acc-2',
    date: '2024-03-16',
    dayOfWeek: 6, // Saturday
    tradeCount: 2,
    wins: 1,
    losses: 1,
    breakeven: 0,
    grossProfit: 300,
    grossLoss: 100,
    totalPnl: 200,
    totalVolume: 2,
    bestTrade: 300,
    worstTrade: -100,
    sumRiskReward: 3.0,
    riskRewardCount: 2,
    pnlSequence: [300, -100],
    symbolDistribution: {
      MSFT: { count: 1, wins: 1, pnl: 300 },
      TSLA: { count: 1, wins: 0, pnl: -100 },
    },
    strategyDistribution: {
      Reversal: { count: 1, wins: 1, pnl: 300 },
      Breakout: { count: 1, wins: 0, pnl: -100 },
    },
    sessionDistribution: {},
    outcomeDistribution: { TP: 1, SL: 1 },
    hourlyBreakdown: {
      '14': { count: 2, wins: 1, pnl: 200 },
    },
  },
];

// --- Tests ------------------------------------------------------------------

beforeEach(() => {
  ddbMock.reset();
});

describe('analytics handler', () => {
  // -- Hourly stats ----------------------------------------------------------

  it('returns hourlyStats, bestHour, and worstHour for type=hourly', async () => {
    ddbMock.on(QueryCommand).resolves({ Items: sampleDailyRecords });

    const res = await handler(makeEvent({ queryStringParameters: { type: 'hourly' } })) as any;

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(true);
    expect(body.data.hourlyStats).toBeDefined();
    expect(Array.isArray(body.data.hourlyStats)).toBe(true);
    expect(body.data.bestHour).toBeDefined();
    expect(body.data.worstHour).toBeDefined();
  });

  // -- Daily win rate --------------------------------------------------------

  it('returns dailyWinRate, totalDays, and overallWinRate for type=daily-win-rate', async () => {
    ddbMock.on(QueryCommand).resolves({ Items: sampleDailyRecords });

    const res = await handler(makeEvent({ queryStringParameters: { type: 'daily-win-rate' } })) as any;

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(true);
    expect(body.data.dailyWinRate).toBeDefined();
    expect(Array.isArray(body.data.dailyWinRate)).toBe(true);
    expect(typeof body.data.totalDays).toBe('number');
    expect(typeof body.data.overallWinRate).toBe('number');
  });

  // -- Symbol distribution ---------------------------------------------------

  it('returns symbols, totalSymbols, mostTraded, and mostProfitable for type=symbol-distribution', async () => {
    ddbMock.on(QueryCommand).resolves({ Items: sampleDailyRecords });

    const res = await handler(makeEvent({ queryStringParameters: { type: 'symbol-distribution' } })) as any;

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(true);
    expect(Array.isArray(body.data.symbols)).toBe(true);
    expect(typeof body.data.totalSymbols).toBe('number');
    expect(body.data.mostTraded).toBeDefined();
    expect(body.data.mostProfitable).toBeDefined();
    // Should have AAPL, MSFT, TSLA from the two daily records
    const symbolNames = body.data.symbols.map((s: any) => s.symbol);
    expect(symbolNames).toContain('AAPL');
    expect(symbolNames).toContain('MSFT');
  });

  // -- Strategy distribution -------------------------------------------------

  it('returns strategies, totalStrategies, mostUsed, and mostProfitable for type=strategy-distribution', async () => {
    ddbMock.on(QueryCommand).resolves({ Items: sampleDailyRecords });

    const res = await handler(makeEvent({ queryStringParameters: { type: 'strategy-distribution' } })) as any;

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(true);
    expect(Array.isArray(body.data.strategies)).toBe(true);
    expect(typeof body.data.totalStrategies).toBe('number');
    expect(body.data.mostUsed).toBeDefined();
    expect(body.data.mostProfitable).toBeDefined();
  });

  // -- Invalid type ----------------------------------------------------------

  it('returns 400 for an unknown analytics type', async () => {
    ddbMock.on(QueryCommand).resolves({ Items: sampleDailyRecords });

    const res = await handler(makeEvent({ queryStringParameters: { type: 'unknown-type' } })) as any;

    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.errorCode).toBe('VALIDATION_ERROR');
  });

  // -- Auth ------------------------------------------------------------------

  it('returns 401 when authorization header is missing', async () => {
    const event = makeEvent({ headers: {} });
    const res = await handler(event) as any;

    expect(res.statusCode).toBe(401);
  });

  // -- Empty records ---------------------------------------------------------

  it('returns empty arrays when user has no daily stats (hourly)', async () => {
    ddbMock.on(QueryCommand).resolves({ Items: [] });

    const res = await handler(makeEvent({ queryStringParameters: { type: 'hourly' } })) as any;

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.data.hourlyStats).toEqual([]);
  });

  it('returns empty arrays when user has no daily stats (daily-win-rate)', async () => {
    ddbMock.on(QueryCommand).resolves({ Items: [] });

    const res = await handler(makeEvent({ queryStringParameters: { type: 'daily-win-rate' } })) as any;

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.data.dailyWinRate).toEqual([]);
    expect(body.data.totalDays).toBe(0);
  });

  it('returns empty arrays when user has no daily stats (symbol-distribution)', async () => {
    ddbMock.on(QueryCommand).resolves({ Items: [] });

    const res = await handler(makeEvent({ queryStringParameters: { type: 'symbol-distribution' } })) as any;

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.data.symbols).toEqual([]);
    expect(body.data.totalSymbols).toBe(0);
  });

  it('returns empty arrays when user has no daily stats (strategy-distribution)', async () => {
    ddbMock.on(QueryCommand).resolves({ Items: [] });

    const res = await handler(makeEvent({ queryStringParameters: { type: 'strategy-distribution' } })) as any;

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.data.strategies).toEqual([]);
    expect(body.data.totalStrategies).toBe(0);
  });

  // -- DynamoDB error --------------------------------------------------------

  it('returns 500 when DynamoDB query fails', async () => {
    ddbMock.on(QueryCommand).rejects(new Error('DynamoDB timeout'));

    const res = await handler(makeEvent()) as any;

    expect(res.statusCode).toBe(500);
  });

  // -- Account filtering -----------------------------------------------------

  it('queries DailyStats GSI for All Accounts', async () => {
    ddbMock.on(QueryCommand).resolves({ Items: [] });

    await handler(makeEvent({ queryStringParameters: { type: 'hourly', accountId: 'ALL' } })) as any;

    const calls = ddbMock.commandCalls(QueryCommand);
    expect(calls.length).toBe(1);
    expect(calls[0].args[0].input.IndexName).toBe('stats-by-date-gsi');
  });

  it('queries DailyStats main table for specific account', async () => {
    ddbMock.on(QueryCommand).resolves({ Items: [] });

    await handler(makeEvent({ queryStringParameters: { type: 'hourly', accountId: 'acc-1' } })) as any;

    const calls = ddbMock.commandCalls(QueryCommand);
    expect(calls.length).toBe(1);
    // Single account queries main table (no IndexName), using SK BETWEEN
    expect(calls[0].args[0].input.IndexName).toBeUndefined();
    expect(calls[0].args[0].input.KeyConditionExpression).toContain('sk BETWEEN');
  });

  // -- Date filtering --------------------------------------------------------

  it('passes startDate and endDate to DailyStats query', async () => {
    ddbMock.on(QueryCommand).resolves({ Items: [] });

    await handler(makeEvent({ queryStringParameters: { type: 'hourly', startDate: '2024-03-01', endDate: '2024-03-31' } })) as any;

    const calls = ddbMock.commandCalls(QueryCommand);
    const values = calls[0].args[0].input.ExpressionAttributeValues;
    expect(values[':startDate']).toBe('2024-03-01');
    expect(values[':endDate']).toBe('2024-03-31');
  });
});
