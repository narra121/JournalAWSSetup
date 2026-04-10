import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBDocumentClient, PutCommand } from '@aws-sdk/lib-dynamodb';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import type { APIGatewayProxyEventV2 } from 'aws-lambda';

// Mock environment variables before importing handler
vi.stubEnv('TRADES_TABLE', 'test-trades');
vi.stubEnv('IMAGES_BUCKET', 'test-bucket');

const { handler } = await import('../app.ts');

const ddbMock = mockClient(DynamoDBDocumentClient);
const s3Mock = mockClient(S3Client);

// ─── Helpers ────────────────────────────────────────────────────

function makeJwt(sub: string): string {
  const header = btoa(JSON.stringify({ alg: 'RS256' }));
  const payload = btoa(JSON.stringify({ sub }));
  return `${header}.${payload}.sig`;
}

function makeEvent(body: any, overrides: Partial<APIGatewayProxyEventV2> = {}): APIGatewayProxyEventV2 {
  return {
    version: '2.0',
    routeKey: 'POST /trades',
    rawPath: '/trades',
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
      http: { method: 'POST', path: '/trades', protocol: 'HTTP/1.1', sourceIp: '127.0.0.1', userAgent: 'test' },
      requestId: 'req-1',
      routeKey: 'POST /trades',
      stage: '$default',
      time: '01/Jan/2024:00:00:00 +0000',
      timeEpoch: 0,
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
    isBase64Encoded: false,
    ...overrides,
    // Restore headers after spread to avoid overrides clobbering our auth header
  } as unknown as APIGatewayProxyEventV2;
}

// Minimal valid payload (what tests were using)
const validTrade = {
  symbol: 'AAPL',
  side: 'BUY',
  quantity: 100,
  openDate: '2024-06-15',
  entryPrice: 150,
  exitPrice: 160,
  outcome: 'TP',
};

// Full payload matching what the UI actually sends via tradesApi.createTrade
const fullUiTrade = {
  symbol: 'NIFTY',
  side: 'BUY',
  quantity: 50,
  entryPrice: 22000,
  exitPrice: 22200,
  stopLoss: 21900,
  takeProfit: 22400,
  openDate: '2024-06-15T09:30:00.000Z',
  closeDate: '2024-06-15T15:00:00.000Z',
  outcome: 'TP',
  pnl: 10000,
  riskRewardRatio: 2,
  setupType: 'Breakout',
  tradingSession: 'Morning',
  marketCondition: 'Trending',
  tradeNotes: 'Clean breakout above resistance',
  newsEvents: ['RBI policy decision'],
  mistakes: ['Entered too early'],
  lessons: ['Wait for confirmation candle'],
  tags: ['nifty', 'breakout'],
  accountIds: ['acc-1'],
  brokenRuleIds: [],
  images: [],
};

// ─── Tests ──────────────────────────────────────────────────────

beforeEach(() => {
  ddbMock.reset();
  s3Mock.reset();
  ddbMock.on(PutCommand).resolves({});
  s3Mock.on(PutObjectCommand).resolves({});
});

describe('create-trade handler', () => {
  // ── Success ─────────────────────────────────────────────────

  it('creates a trade and returns 201', async () => {
    const res = await handler(makeEvent(validTrade), {} as any, () => {}) as any;

    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(true);
    expect(body.data.trade).toBeDefined();
    expect(body.data.trade.symbol).toBe('AAPL');
    expect(body.data.trade.side).toBe('BUY');
    expect(body.data.trade.quantity).toBe(100);
    expect(body.data.trade.userId).toBe('user-1');
    expect(body.data.trade.tradeId).toBeDefined();
    expect(body.data.trade.createdAt).toBeDefined();
  });

  it('calculates PnL for BUY trades when not provided', async () => {
    const trade = { ...validTrade, pnl: undefined };
    const res = await handler(makeEvent(trade), {} as any, () => {}) as any;

    const body = JSON.parse(res.body);
    // (exitPrice - entryPrice) * quantity = (160 - 150) * 100 = 1000
    expect(body.data.trade.pnl).toBe(1000);
  });

  it('calculates PnL for SELL trades when not provided', async () => {
    const trade = { ...validTrade, side: 'SELL', pnl: undefined };
    const res = await handler(makeEvent(trade), {} as any, () => {}) as any;

    const body = JSON.parse(res.body);
    // (entryPrice - exitPrice) * quantity = (150 - 160) * 100 = -1000
    expect(body.data.trade.pnl).toBe(-1000);
  });

  it('uses frontend-provided PnL when available', async () => {
    const trade = { ...validTrade, pnl: 500 };
    const res = await handler(makeEvent(trade), {} as any, () => {}) as any;

    const body = JSON.parse(res.body);
    expect(body.data.trade.pnl).toBe(500);
  });

  it('defaults accountId to -1 when not specified', async () => {
    const res = await handler(makeEvent(validTrade), {} as any, () => {}) as any;

    const body = JSON.parse(res.body);
    expect(body.data.trade.accountId).toBe('-1');
  });

  // ── Auth errors ─────────────────────────────────────────────

  it('returns 401 when authorization header is missing', async () => {
    const event = makeEvent(validTrade);
    event.headers = {};
    const res = await handler(event, {} as any, () => {}) as any;

    expect(res.statusCode).toBe(401);
    const body = JSON.parse(res.body);
    expect(body.errorCode).toBe('UNAUTHORIZED');
  });

  // ── Validation errors ───────────────────────────────────────

  it('returns 400 when body is missing', async () => {
    const event = makeEvent(undefined);
    event.body = undefined;
    const res = await handler(event, {} as any, () => {}) as any;

    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.errorCode).toBe('VALIDATION_ERROR');
  });

  it('returns 400 when body is invalid JSON', async () => {
    const event = makeEvent(validTrade);
    event.body = '{not-valid-json';
    const res = await handler(event, {} as any, () => {}) as any;

    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.errorCode).toBe('VALIDATION_ERROR');
    expect(body.message).toContain('Invalid JSON');
  });

  it('returns 400 when required field "symbol" is missing', async () => {
    const trade = { side: 'BUY', quantity: 100, openDate: '2024-06-15' };
    const res = await handler(makeEvent(trade), {} as any, () => {}) as any;

    expect(res.statusCode).toBe(400);
  });

  it('returns 400 when required field "side" is missing', async () => {
    const trade = { symbol: 'AAPL', quantity: 100, openDate: '2024-06-15' };
    const res = await handler(makeEvent(trade), {} as any, () => {}) as any;

    expect(res.statusCode).toBe(400);
  });

  it('returns 400 when required field "quantity" is missing', async () => {
    const trade = { symbol: 'AAPL', side: 'BUY', openDate: '2024-06-15' };
    const res = await handler(makeEvent(trade), {} as any, () => {}) as any;

    expect(res.statusCode).toBe(400);
  });

  it('returns 400 when required field "openDate" is missing', async () => {
    const trade = { symbol: 'AAPL', side: 'BUY', quantity: 100 };
    const res = await handler(makeEvent(trade), {} as any, () => {}) as any;

    expect(res.statusCode).toBe(400);
  });

  // ── Full UI payload ─────────────────────────────────────────

  it('creates a trade with the full UI payload (all optional fields)', async () => {
    const res = await handler(makeEvent(fullUiTrade), {} as any, () => {}) as any;

    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(true);
    expect(body.data.trade.symbol).toBe('NIFTY');
    expect(body.data.trade.pnl).toBe(10000);
    expect(body.data.trade.setupType).toBe('Breakout');
    expect(body.data.trade.tradingSession).toBe('Morning');
    expect(body.data.trade.marketCondition).toBe('Trending');
    expect(body.data.trade.tradeNotes).toBe('Clean breakout above resistance');
    expect(body.data.trade.newsEvents).toEqual(['RBI policy decision']);
    expect(body.data.trade.mistakes).toEqual(['Entered too early']);
    expect(body.data.trade.brokenRuleIds).toEqual([]);
    expect(body.data.trade.accountId).toBe('acc-1');
  });

  it('accepts trade with zero stopLoss and takeProfit', async () => {
    const trade = { ...validTrade, stopLoss: 0, takeProfit: 0, riskRewardRatio: 0 };
    const res = await handler(makeEvent(trade), {} as any, () => {}) as any;

    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body);
    expect(body.data.trade.stopLoss).toBe(0);
    expect(body.data.trade.takeProfit).toBe(0);
  });

  it('accepts trade with null optional fields', async () => {
    const trade = {
      ...validTrade,
      exitPrice: null,
      stopLoss: null,
      takeProfit: null,
      setupType: null,
      tradingSession: null,
      marketCondition: null,
      tradeNotes: null,
      closeDate: null,
    };
    const res = await handler(makeEvent(trade), {} as any, () => {}) as any;

    expect(res.statusCode).toBe(201);
  });

  it('accepts trade with empty arrays for optional list fields', async () => {
    const trade = {
      ...validTrade,
      newsEvents: [],
      mistakes: [],
      lessons: [],
      tags: [],
      brokenRuleIds: [],
      images: [],
    };
    const res = await handler(makeEvent(trade), {} as any, () => {}) as any;

    expect(res.statusCode).toBe(201);
  });

  it('accepts trade with images containing data URI in url', async () => {
    const trade = {
      ...validTrade,
      images: [
        {
          id: 'img-1',
          url: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
          timeframe: '1H',
          description: 'Entry screenshot',
        },
      ],
    };
    const res = await handler(makeEvent(trade), {} as any, () => {}) as any;

    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body);
    expect(body.data.trade.images).toHaveLength(1);
    expect(body.data.trade.images[0].id).toBeDefined();
    // Should have uploaded to S3
    expect(s3Mock.commandCalls(PutObjectCommand)).toHaveLength(1);
  });

  it('accepts trade with images containing empty description', async () => {
    const trade = {
      ...validTrade,
      images: [
        {
          id: 'img-1',
          url: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
          timeframe: '1H',
          description: '',
        },
      ],
    };
    const res = await handler(makeEvent(trade), {} as any, () => {}) as any;

    expect(res.statusCode).toBe(201);
  });

  it('accepts trade with ISO datetime string for openDate', async () => {
    const trade = { ...validTrade, openDate: '2024-06-15T09:30:00.000Z' };
    const res = await handler(makeEvent(trade), {} as any, () => {}) as any;

    expect(res.statusCode).toBe(201);
  });

  // ── DynamoDB errors ─────────────────────────────────────────

  it('returns 500 when DynamoDB write fails', async () => {
    ddbMock.on(PutCommand).rejects(new Error('DynamoDB write error'));

    const res = await handler(makeEvent(validTrade), {} as any, () => {}) as any;

    expect(res.statusCode).toBe(500);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(false);
  });

  // ── Multiple accountIds ─────────────────────────────────────

  it('creates multiple trades when multiple accountIds provided', async () => {
    const trade = { ...validTrade, accountIds: ['acc-1', 'acc-2'] };
    const res = await handler(makeEvent(trade), {} as any, () => {}) as any;

    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body);
    // Multiple accounts should return trades array
    expect(body.data.trades).toBeDefined();
    expect(body.data.count).toBe(2);
    // Should have called PutCommand twice
    expect(ddbMock.commandCalls(PutCommand)).toHaveLength(2);
  });
});
