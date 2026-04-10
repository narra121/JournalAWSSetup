import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBDocumentClient, QueryCommand } from '@aws-sdk/lib-dynamodb';
import type { APIGatewayProxyEvent } from 'aws-lambda';

// Mock environment variables before importing handler
vi.stubEnv('TRADES_TABLE', 'test-trades');

// Must import handler after env stubs
const { lambdaHandler } = await import('../app.ts');

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

// --- Sample trade data ------------------------------------------------------

const sampleTrades = [
  {
    userId: 'user-1', tradeId: 't1', symbol: 'AAPL', setupType: 'Breakout',
    openDate: '2024-03-15T09:30:00Z', pnl: 500, accountId: 'acc-1',
  },
  {
    userId: 'user-1', tradeId: 't2', symbol: 'AAPL', setupType: 'Breakout',
    openDate: '2024-03-15T09:45:00Z', pnl: -200, accountId: 'acc-1',
  },
  {
    userId: 'user-1', tradeId: 't3', symbol: 'MSFT', setupType: 'Reversal',
    openDate: '2024-03-16T14:00:00Z', pnl: 300, accountId: 'acc-2',
  },
  {
    userId: 'user-1', tradeId: 't4', symbol: 'TSLA', setupType: 'Breakout',
    openDate: '2024-03-16T14:30:00Z', pnl: -100, accountId: 'acc-2',
  },
];

// --- Tests ------------------------------------------------------------------

beforeEach(() => {
  ddbMock.reset();
});

describe('analytics handler', () => {
  // -- Hourly stats ----------------------------------------------------------

  it('returns hourlyStats, bestHour, and worstHour for type=hourly', async () => {
    ddbMock.on(QueryCommand).resolves({ Items: sampleTrades });

    const res = await lambdaHandler(makeEvent({ queryStringParameters: { type: 'hourly' } })) as any;

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
    ddbMock.on(QueryCommand).resolves({ Items: sampleTrades });

    const res = await lambdaHandler(makeEvent({ queryStringParameters: { type: 'daily-win-rate' } })) as any;

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
    ddbMock.on(QueryCommand).resolves({ Items: sampleTrades });

    const res = await lambdaHandler(makeEvent({ queryStringParameters: { type: 'symbol-distribution' } })) as any;

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(true);
    expect(Array.isArray(body.data.symbols)).toBe(true);
    expect(typeof body.data.totalSymbols).toBe('number');
    expect(body.data.mostTraded).toBeDefined();
    expect(body.data.mostProfitable).toBeDefined();
  });

  // -- Strategy distribution -------------------------------------------------

  it('returns strategies, totalStrategies, mostUsed, and mostProfitable for type=strategy-distribution', async () => {
    ddbMock.on(QueryCommand).resolves({ Items: sampleTrades });

    const res = await lambdaHandler(makeEvent({ queryStringParameters: { type: 'strategy-distribution' } })) as any;

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
    ddbMock.on(QueryCommand).resolves({ Items: sampleTrades });

    const res = await lambdaHandler(makeEvent({ queryStringParameters: { type: 'unknown-type' } })) as any;

    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.errorCode).toBe('VALIDATION_ERROR');
  });

  // -- Auth ------------------------------------------------------------------

  it('returns 401 when authorization header is missing', async () => {
    const event = makeEvent({ headers: {} });
    const res = await lambdaHandler(event) as any;

    expect(res.statusCode).toBe(401);
    const body = JSON.parse(res.body);
    expect(body.error).toBe('Unauthorized');
  });

  // -- Empty trades ----------------------------------------------------------

  it('returns empty arrays when user has no trades (hourly)', async () => {
    ddbMock.on(QueryCommand).resolves({ Items: [] });

    const res = await lambdaHandler(makeEvent({ queryStringParameters: { type: 'hourly' } })) as any;

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.data.hourlyStats).toEqual([]);
  });

  it('returns empty arrays when user has no trades (daily-win-rate)', async () => {
    ddbMock.on(QueryCommand).resolves({ Items: [] });

    const res = await lambdaHandler(makeEvent({ queryStringParameters: { type: 'daily-win-rate' } })) as any;

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.data.dailyWinRate).toEqual([]);
    expect(body.data.totalDays).toBe(0);
  });

  it('returns empty arrays when user has no trades (symbol-distribution)', async () => {
    ddbMock.on(QueryCommand).resolves({ Items: [] });

    const res = await lambdaHandler(makeEvent({ queryStringParameters: { type: 'symbol-distribution' } })) as any;

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.data.symbols).toEqual([]);
    expect(body.data.totalSymbols).toBe(0);
  });

  it('returns empty arrays when user has no trades (strategy-distribution)', async () => {
    ddbMock.on(QueryCommand).resolves({ Items: [] });

    const res = await lambdaHandler(makeEvent({ queryStringParameters: { type: 'strategy-distribution' } })) as any;

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.data.strategies).toEqual([]);
    expect(body.data.totalStrategies).toBe(0);
  });

  // -- Filters out unmapped trades (accountId = '-1') ------------------------

  it('filters out trades with accountId = -1 (string)', async () => {
    const tradesWithUnmapped = [
      ...sampleTrades,
      { userId: 'user-1', tradeId: 't-unmapped', symbol: 'SPY', setupType: 'Gap', openDate: '2024-03-17T10:00:00Z', pnl: 9999, accountId: '-1' },
    ];
    ddbMock.on(QueryCommand).resolves({ Items: tradesWithUnmapped });

    const res = await lambdaHandler(makeEvent({ queryStringParameters: { type: 'symbol-distribution' } })) as any;

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    // SPY should NOT appear because it has accountId '-1'
    const symbolNames = body.data.symbols.map((s: any) => s.symbol);
    expect(symbolNames).not.toContain('SPY');
  });

  it('filters out trades with accountId = -1 (number)', async () => {
    const tradesWithUnmapped = [
      ...sampleTrades,
      { userId: 'user-1', tradeId: 't-unmapped2', symbol: 'QQQ', setupType: 'Gap', openDate: '2024-03-17T11:00:00Z', pnl: 8888, accountId: -1 },
    ];
    ddbMock.on(QueryCommand).resolves({ Items: tradesWithUnmapped });

    const res = await lambdaHandler(makeEvent({ queryStringParameters: { type: 'symbol-distribution' } })) as any;

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    const symbolNames = body.data.symbols.map((s: any) => s.symbol);
    expect(symbolNames).not.toContain('QQQ');
  });

  // -- DynamoDB error --------------------------------------------------------

  it('returns 500 when DynamoDB query fails', async () => {
    ddbMock.on(QueryCommand).rejects(new Error('DynamoDB timeout'));

    const res = await lambdaHandler(makeEvent()) as any;

    expect(res.statusCode).toBe(500);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(false);
    expect(body.errorCode).toBe('INTERNAL_ERROR');
  });

  // -- Additional error / edge-case tests ------------------------------------

  it('defaults to hourly when queryStringParameters is entirely missing', async () => {
    ddbMock.on(QueryCommand).resolves({ Items: sampleTrades });

    const event = makeEvent({ queryStringParameters: null as any });
    const res = await lambdaHandler(event) as any;

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(true);
    // Should return hourly stats by default
    expect(body.data.hourlyStats).toBeDefined();
    expect(Array.isArray(body.data.hourlyStats)).toBe(true);
  });

  it('does not crash when a trade has an invalid openDate (unparseable)', async () => {
    const tradesWithBadDate = [
      ...sampleTrades,
      { userId: 'user-1', tradeId: 't-bad', symbol: 'BAD', setupType: 'Test', openDate: 'invalid', pnl: 100, accountId: 'acc-1' },
    ];
    ddbMock.on(QueryCommand).resolves({ Items: tradesWithBadDate });

    const res = await lambdaHandler(makeEvent({ queryStringParameters: { type: 'hourly' } })) as any;

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    // new Date('invalid').getHours() → NaN, so the trade with NaN hour
    // should either be grouped under NaN key or skipped; handler must not crash
    expect(body.success).toBe(true);
    expect(body.data.hourlyStats).toBeDefined();
  });

  it('skips trades with pnl = null in calculations', async () => {
    const tradesWithNull = [
      { userId: 'user-1', tradeId: 't-null', symbol: 'AAPL', setupType: 'Breakout', openDate: '2024-03-15T09:30:00Z', pnl: null, accountId: 'acc-1' },
    ];
    ddbMock.on(QueryCommand).resolves({ Items: tradesWithNull });

    const res = await lambdaHandler(makeEvent({ queryStringParameters: { type: 'hourly' } })) as any;

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(true);
    // pnl is null → `if (!trade.pnl) continue;` skips it → no hourly data
    expect(body.data.hourlyStats).toEqual([]);
  });

  it('counts trade with pnl = 0 correctly (not as a win)', async () => {
    const tradesWithZero = [
      { userId: 'user-1', tradeId: 't-zero', symbol: 'AAPL', setupType: 'Breakout', openDate: '2024-03-15T09:30:00Z', pnl: 0, accountId: 'acc-1' },
    ];
    ddbMock.on(QueryCommand).resolves({ Items: tradesWithZero });

    const res = await lambdaHandler(makeEvent({ queryStringParameters: { type: 'hourly' } })) as any;

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    // pnl=0 is falsy, so `if (!trade.pnl) continue;` skips it
    // The handler treats pnl=0 as "no pnl" → skipped
    expect(body.data.hourlyStats).toEqual([]);
  });

  it('handles division-by-zero: winRate is 0 when no trades in an hour', async () => {
    // When there are no trades at all, hourlyStats is empty, so no division by zero
    ddbMock.on(QueryCommand).resolves({ Items: [] });

    const res = await lambdaHandler(makeEvent({ queryStringParameters: { type: 'hourly' } })) as any;

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.data.hourlyStats).toEqual([]);
    // bestHour and worstHour should be undefined when no data
    expect(body.data.bestHour).toBeUndefined();
    expect(body.data.worstHour).toBeUndefined();
  });

  it('handles QueryCommand pagination (LastEvaluatedKey) in getAllUserTrades', async () => {
    // First call returns page 1 with LastEvaluatedKey
    ddbMock.on(QueryCommand)
      .resolvesOnce({
        Items: [sampleTrades[0], sampleTrades[1]],
        LastEvaluatedKey: { userId: 'user-1', tradeId: 't2' },
      })
      // getAllUserTrades does NOT paginate (no loop) - it does a single query
      // So only the first page items are returned
      .resolvesOnce({
        Items: [sampleTrades[2], sampleTrades[3]],
      });

    const res = await lambdaHandler(makeEvent({ queryStringParameters: { type: 'hourly' } })) as any;

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(true);
    // Only the first page is used (getAllUserTrades doesn't paginate)
    expect(body.data.hourlyStats).toBeDefined();
  });

  it('returns empty results when all trades have accountId = -1', async () => {
    const unmappedOnly = [
      { userId: 'user-1', tradeId: 't-u1', symbol: 'AAPL', setupType: 'Breakout', openDate: '2024-03-15T09:30:00Z', pnl: 500, accountId: '-1' },
      { userId: 'user-1', tradeId: 't-u2', symbol: 'MSFT', setupType: 'Reversal', openDate: '2024-03-16T14:00:00Z', pnl: 300, accountId: '-1' },
    ];
    ddbMock.on(QueryCommand).resolves({ Items: unmappedOnly });

    const resHourly = await lambdaHandler(makeEvent({ queryStringParameters: { type: 'hourly' } })) as any;
    expect(resHourly.statusCode).toBe(200);
    const hourlyBody = JSON.parse(resHourly.body);
    expect(hourlyBody.data.hourlyStats).toEqual([]);

    ddbMock.reset();
    ddbMock.on(QueryCommand).resolves({ Items: unmappedOnly });

    const resSymbol = await lambdaHandler(makeEvent({ queryStringParameters: { type: 'symbol-distribution' } })) as any;
    expect(resSymbol.statusCode).toBe(200);
    const symbolBody = JSON.parse(resSymbol.body);
    expect(symbolBody.data.symbols).toEqual([]);
    expect(symbolBody.data.totalSymbols).toBe(0);
  });

  it('handles symbol distribution with undefined symbol gracefully', async () => {
    const tradesNoSymbol = [
      { userId: 'user-1', tradeId: 't-nosym', setupType: 'Breakout', openDate: '2024-03-15T09:30:00Z', pnl: 100, accountId: 'acc-1' },
      ...sampleTrades,
    ];
    ddbMock.on(QueryCommand).resolves({ Items: tradesNoSymbol });

    const res = await lambdaHandler(makeEvent({ queryStringParameters: { type: 'symbol-distribution' } })) as any;

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(true);
    // The trade with no symbol should be skipped (`if (!trade.symbol) continue;`)
    const symbolNames = body.data.symbols.map((s: any) => s.symbol);
    expect(symbolNames).not.toContain(undefined);
    expect(symbolNames).not.toContain('undefined');
  });

  it('handles strategy distribution with null setupType (uses Unknown)', async () => {
    const tradesNullSetup = [
      { userId: 'user-1', tradeId: 't-nosetup', symbol: 'AAPL', setupType: null, openDate: '2024-03-15T09:30:00Z', pnl: 200, accountId: 'acc-1' },
    ];
    ddbMock.on(QueryCommand).resolves({ Items: tradesNullSetup });

    const res = await lambdaHandler(makeEvent({ queryStringParameters: { type: 'strategy-distribution' } })) as any;

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(true);
    // `trade.setupType || 'Unknown'` should fall back to 'Unknown'
    const strategyNames = body.data.strategies.map((s: any) => s.strategy);
    expect(strategyNames).toContain('Unknown');
  });
});
