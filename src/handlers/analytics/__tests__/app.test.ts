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
});
