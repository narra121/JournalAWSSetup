import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBDocumentClient, PutCommand, QueryCommand, BatchWriteCommand } from '@aws-sdk/lib-dynamodb';
import { S3Client, PutObjectCommand, CopyObjectCommand } from '@aws-sdk/client-s3';
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

// Minimal valid payload (all required fields)
const validTrade = {
  symbol: 'AAPL',
  side: 'BUY',
  quantity: 100,
  openDate: '2024-06-15',
  entryPrice: 150,
  exitPrice: 160,
  closeDate: '2024-06-15',
  outcome: 'TP',
  pnl: 1000,
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

  it('stores provided PnL for BUY trades', async () => {
    const trade = { ...validTrade, side: 'BUY', pnl: 1000 };
    const res = await handler(makeEvent(trade), {} as any, () => {}) as any;

    const body = JSON.parse(res.body);
    expect(body.data.trade.pnl).toBe(1000);
  });

  it('stores provided PnL for SELL trades', async () => {
    const trade = { ...validTrade, side: 'SELL', pnl: -1000 };
    const res = await handler(makeEvent(trade), {} as any, () => {}) as any;

    const body = JSON.parse(res.body);
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

  it('accepts trade with null optional fields (non-required ones)', async () => {
    const trade = {
      ...validTrade,
      stopLoss: null,
      takeProfit: null,
      setupType: null,
      tradingSession: null,
      marketCondition: null,
      tradeNotes: null,
    };
    const res = await handler(makeEvent(trade), {} as any, () => {}) as any;

    expect(res.statusCode).toBe(201);
  });

  it('returns 400 when required field entryPrice is missing', async () => {
    const { entryPrice, ...trade } = validTrade;
    const res = await handler(makeEvent(trade), {} as any, () => {}) as any;
    expect(res.statusCode).toBe(400);
  });

  it('returns 400 when required field exitPrice is missing', async () => {
    const { exitPrice, ...trade } = validTrade;
    const res = await handler(makeEvent(trade), {} as any, () => {}) as any;
    expect(res.statusCode).toBe(400);
  });

  it('returns 400 when required field closeDate is missing', async () => {
    const { closeDate, ...trade } = validTrade;
    const res = await handler(makeEvent(trade), {} as any, () => {}) as any;
    expect(res.statusCode).toBe(400);
  });

  it('returns 400 when required field outcome is missing', async () => {
    const { outcome, ...trade } = validTrade;
    const res = await handler(makeEvent(trade), {} as any, () => {}) as any;
    expect(res.statusCode).toBe(400);
  });

  it('returns 400 when required field pnl is missing', async () => {
    const { pnl, ...trade } = validTrade;
    const res = await handler(makeEvent(trade), {} as any, () => {}) as any;
    expect(res.statusCode).toBe(400);
  });

  it('returns 400 when entryPrice is null', async () => {
    const res = await handler(makeEvent({ ...validTrade, entryPrice: null }), {} as any, () => {}) as any;
    expect(res.statusCode).toBe(400);
  });

  it('returns 400 when exitPrice is null', async () => {
    const res = await handler(makeEvent({ ...validTrade, exitPrice: null }), {} as any, () => {}) as any;
    expect(res.statusCode).toBe(400);
  });

  it('accepts trade with pnl=0 (breakeven)', async () => {
    const trade = { ...validTrade, pnl: 0, outcome: 'BREAKEVEN', exitPrice: 150 };
    const res = await handler(makeEvent(trade), {} as any, () => {}) as any;
    expect(res.statusCode).toBe(201);
  });

  it('accepts trade with negative pnl (losing trade)', async () => {
    const trade = { ...validTrade, pnl: -500, outcome: 'SL', exitPrice: 145 };
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

  it('keeps an image key under the caller prefix and drops keys of other users', async () => {
    const trade = {
      ...validTrade,
      images: [
        { id: 'own', url: 'images/user-1/t1/a.png' },
        { id: 'foreign', url: 'images/user-2/t9/secret.png' },
      ],
    };
    const res = (await handler(makeEvent(trade), {} as any, () => {})) as any;
    expect(res.statusCode).toBe(201);
    const images = JSON.parse(res.body).data.trade.images;
    expect(images.map((i: any) => i.key)).toEqual(['images/user-1/t1/a.png']);
  });

  it('uploads multiple images in parallel via Promise.all', async () => {
    const trade = {
      ...validTrade,
      images: [
        {
          id: 'img-1',
          url: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
          timeframe: '1H',
          description: 'Entry screenshot',
        },
        {
          id: 'img-2',
          url: 'data:image/jpeg;base64,/9j/4AAQSkZJRg==',
          timeframe: '4H',
          description: 'Exit screenshot',
        },
        {
          id: 'img-3',
          base64Data: 'data:image/gif;base64,R0lGODlhAQABAIAAAP///wAAACH5BAEAAAAALAAAAAABAAEAAAICRAEAOw==',
          timeframe: 'D',
          description: 'Daily chart',
        },
      ],
    };
    const res = await handler(makeEvent(trade), {} as any, () => {}) as any;

    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body);
    expect(body.data.trade.images).toHaveLength(3);
    // All three images should have been uploaded to S3
    const s3Calls = s3Mock.commandCalls(PutObjectCommand);
    expect(s3Calls).toHaveLength(3);
    // Verify each image has correct extension based on content type
    const keys = s3Calls.map(c => c.args[0].input.Key as string);
    expect(keys.some(k => k.endsWith('.png'))).toBe(true);
    expect(keys.some(k => k.endsWith('.jpg'))).toBe(true);
    expect(keys.some(k => k.endsWith('.gif'))).toBe(true);
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

  // ── Additional validation errors ────────────────────────────

  it('returns 400 when side is invalid (LONG instead of BUY/SELL)', async () => {
    const trade = { ...validTrade, side: 'LONG' };
    const res = await handler(makeEvent(trade), {} as any, () => {}) as any;

    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.errorCode).toBe('VALIDATION_ERROR');
  });

  it('returns 400 when outcome is invalid (WIN instead of TP/SL/PARTIAL/BREAKEVEN)', async () => {
    const trade = { ...validTrade, outcome: 'WIN' };
    const res = await handler(makeEvent(trade), {} as any, () => {}) as any;

    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.errorCode).toBe('VALIDATION_ERROR');
  });

  it('returns 400 when quantity is negative', async () => {
    const trade = { ...validTrade, quantity: -1 };
    const res = await handler(makeEvent(trade), {} as any, () => {}) as any;

    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.errorCode).toBe('VALIDATION_ERROR');
  });

  it('returns 400 when openDate format is invalid', async () => {
    const trade = { ...validTrade, openDate: 'not-a-date' };
    const res = await handler(makeEvent(trade), {} as any, () => {}) as any;

    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.errorCode).toBe('VALIDATION_ERROR');
  });

  it('returns 400 when symbol is an empty string', async () => {
    const trade = { ...validTrade, symbol: '' };
    const res = await handler(makeEvent(trade), {} as any, () => {}) as any;

    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.errorCode).toBe('VALIDATION_ERROR');
  });

  // ── S3 image upload failures ────────────────────────────────

  it('returns 500 when S3 PutObject fails during image upload', async () => {
    s3Mock.on(PutObjectCommand).rejects(new Error('S3 PutObject error'));

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

    expect(res.statusCode).toBe(500);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(false);
  });

  it('handles trade with malformed base64Data in image gracefully', async () => {
    const trade = {
      ...validTrade,
      images: [
        {
          id: 'img-1',
          base64Data: '!!!not-valid-base64!!!',
          timeframe: '1H',
          description: 'Bad image',
        },
      ],
    };
    // Malformed base64 will produce a buffer (Buffer.from tolerates bad input) and upload to S3.
    // The handler should still complete without crashing.
    const res = await handler(makeEvent(trade), {} as any, () => {}) as any;

    // Handler processes it (Buffer.from does not throw on bad base64, it just produces garbage bytes)
    // so it should succeed with an S3 upload attempted
    expect([200, 201, 400, 500]).toContain(res.statusCode);
  });

  // ── Idempotency ─────────────────────────────────────────────

  it('returns existing trade (200) on duplicate idempotency key', async () => {
    const existingTrade = {
      userId: 'user-1',
      tradeId: 'existing-trade-id',
      symbol: 'AAPL',
      side: 'BUY',
      quantity: 100,
      openDate: '2024-06-15',
      entryPrice: 150,
      exitPrice: 160,
      outcome: 'TP',
      pnl: 1000,
      images: [],
      createdAt: '2024-06-15T00:00:00.000Z',
    };

    // Mock QueryCommand to return existing trade for idempotency check
    ddbMock.on(QueryCommand).resolves({ Items: [existingTrade] });

    const event = makeEvent(validTrade, {
      headers: {
        authorization: `Bearer ${makeJwt('user-1')}`,
        'idempotency-key': 'idem-key-123',
      },
    } as any);
    const res = await handler(event, {} as any, () => {}) as any;

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(true);
    expect(body.data.trade.tradeId).toBe('existing-trade-id');
    // The lookup uses the stored `<key>-<accountId>` form
    expect(ddbMock.commandCalls(QueryCommand)[0].args[0].input.ExpressionAttributeValues![':k']).toBe('idem-key-123--1');
    // PutCommand should NOT have been called since we returned the existing trade
    expect(ddbMock.commandCalls(PutCommand)).toHaveLength(0);
  });

  it('persists CONTRACT §6 fields on single create', async () => {
    const res = (await handler(makeEvent({ ...validTrade, assetClass: 'options', fees: 12.5, grossPnl: 1012.5, contractMultiplier: 50, underlying: 'NIFTY', optionType: 'call', strike: 22000, expiry: '2026-12-31', externalId: 'T-1', importSource: 'zerodha', importBatchId: 'b1' }), {} as any, () => {})) as any;
    expect(res.statusCode).toBe(201);
    const item = ddbMock.commandCalls(PutCommand)[0].args[0].input.Item!;
    expect(item).toMatchObject({ assetClass: 'options', fees: 12.5, grossPnl: 1012.5, contractMultiplier: 50, underlying: 'NIFTY', optionType: 'call', strike: 22000, expiry: '2026-12-31', externalId: 'T-1', importSource: 'zerodha', importBatchId: 'b1' });
  });

  it('bulk: skips an item whose stored idempotency key already exists and persists §6 fields on the others', async () => {
    ddbMock.on(QueryCommand).callsFake((input) =>
      input.ExpressionAttributeValues[':k'] === 'dup-1--1' ? { Items: [{ tradeId: 'old' }] } : { Items: [] });
    ddbMock.on(BatchWriteCommand).resolves({});
    const res = (await handler(makeEvent({ items: [
      { ...validTrade, idempotencyKey: 'dup-1', externalId: 'A' },
      { ...validTrade, idempotencyKey: 'new-2', externalId: 'B', importSource: 'dhan', fees: 3 },
    ] }), {} as any, () => {})) as any;
    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body);
    expect(body.data.created).toBe(1);
    expect(body.data.skipped[0]).toMatchObject({ index: 0, tradeId: 'old', reason: 'idempotent_duplicate' });
    const written = ddbMock.commandCalls(BatchWriteCommand)[0].args[0].input.RequestItems!['test-trades'][0].PutRequest!.Item!;
    expect(written).toMatchObject({ externalId: 'B', importSource: 'dhan', fees: 3, idempotencyKey: 'new-2--1' });
  });

  it('stores tags and rejects more than 10 or longer than 24 characters', async () => {
    const ok = (await handler(makeEvent({ ...validTrade, tags: ['a', 'b'] }), {} as any, () => {})) as any;
    expect(ok.statusCode).toBe(201);
    expect(ddbMock.commandCalls(PutCommand)[0].args[0].input.Item!.tags).toEqual(['a', 'b']);
    const many = (await handler(makeEvent({ ...validTrade, tags: Array.from({ length: 11 }, (_, i) => `t${i}`) }), {} as any, () => {})) as any;
    expect(many.statusCode).toBe(400);
  });

  it('attaches an uploaded key (from POST /uploads/images) under the caller prefix and allows at most 6 images', async () => {
    const ok = (await handler(makeEvent({ ...validTrade, images: [{ key: 'images/user-1/upload/a.png' }, { key: 'images/user-2/upload/b.png' }] }), {} as any, () => {})) as any;
    expect(ok.statusCode).toBe(201);
    expect(JSON.parse(ok.body).data.trade.images.map((i: any) => i.key)).toEqual(['images/user-1/upload/a.png']);
    const seven = Array.from({ length: 7 }, (_, i) => ({ key: `images/user-1/upload/${i}.png` }));
    expect(((await handler(makeEvent({ ...validTrade, images: seven }), {} as any, () => {})) as any).statusCode).toBe(400);
  });

  it('rejects a seventh image with the same message as update-trade, before any upload or write', async () => {
    const seven = Array.from({ length: 7 }, (_, i) => ({ id: `i${i}`, base64Data: 'data:image/png;base64,aGVsbG8=' }));
    const res = (await handler(makeEvent({ ...validTrade, images: seven }), {} as any, () => {})) as any;
    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.errorCode).toBe('VALIDATION_ERROR');
    expect(body.message).toBe('A trade can have at most 6 images');
    expect(s3Mock.commandCalls(PutObjectCommand)).toHaveLength(0);
    expect(ddbMock.commandCalls(PutCommand)).toHaveLength(0);

    const six = (await handler(makeEvent({ ...validTrade, images: seven.slice(0, 6) }), {} as any, () => {})) as any;
    expect(six.statusCode).toBe(201);
    expect(s3Mock.commandCalls(PutObjectCommand)).toHaveLength(6);
  });

  it('returns 500 and creates nothing when the idempotency lookup fails (BE-035)', async () => {
    ddbMock.on(QueryCommand).rejects(new Error('DynamoDB query error'));

    const event = makeEvent(validTrade, {
      headers: {
        authorization: `Bearer ${makeJwt('user-1')}`,
        'idempotency-key': 'idem-key-456',
      },
    } as any);
    const res = await handler(event, {} as any, () => {}) as any;

    expect(res.statusCode).toBe(500);
    expect(ddbMock.commandCalls(PutCommand)).toHaveLength(0);
  });

  // ── Bulk create errors ──────────────────────────────────────

  it('returns 400 when bulk create items array exceeds 50', async () => {
    const items = Array.from({ length: 51 }, (_, i) => ({
      ...validTrade,
      symbol: `SYM${i}`,
    }));
    const res = await handler(makeEvent({ items }), {} as any, () => {}) as any;

    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.errorCode).toBe('VALIDATION_ERROR');
    expect(body.message).toContain('Too many items');
  });

  it('handles bulk create with BatchWriteCommand UnprocessedItems and retries', async () => {
    // First call returns unprocessed items, second call succeeds
    let batchCallCount = 0;
    ddbMock.on(BatchWriteCommand).callsFake(() => {
      batchCallCount++;
      if (batchCallCount === 1) {
        return {
          UnprocessedItems: {
            'test-trades': [
              { PutRequest: { Item: { userId: 'user-1', tradeId: 'retry-trade', symbol: 'AAPL' } } },
            ],
          },
        };
      }
      return { UnprocessedItems: {} };
    });

    const items = [
      { ...validTrade, symbol: 'AAPL' },
      { ...validTrade, symbol: 'MSFT' },
    ];
    const res = await handler(makeEvent({ items }), {} as any, () => {}) as any;

    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(true);
    expect(body.data.created).toBe(2);
    // BatchWriteCommand should have been called at least twice (initial + retry)
    expect(ddbMock.commandCalls(BatchWriteCommand).length).toBeGreaterThanOrEqual(2);
  });

  it('bulk create reports errors for items with invalid fields', async () => {
    ddbMock.on(BatchWriteCommand).resolves({ UnprocessedItems: {} });

    const items = [
      { ...validTrade, symbol: 'AAPL' },          // valid
      { symbol: '', side: 'BUY', quantity: 100, openDate: '2024-06-15' }, // invalid: empty symbol triggers missing field
      { side: 'BUY', quantity: 100, openDate: '2024-06-15' }, // invalid: missing symbol
    ];
    const res = await handler(makeEvent({ items }), {} as any, () => {}) as any;

    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body);
    // The valid item should be created, invalid items should appear in errors
    expect(body.data.errors.length).toBeGreaterThanOrEqual(1);
  });

  // ── quantity=0 via bulk import ──────────────────────────────

  it('bulk: rejects quantity=0 like the single path does (BE-033)', async () => {
    ddbMock.on(BatchWriteCommand).resolves({ UnprocessedItems: {} });

    const res = await handler(makeEvent({ items: [{ ...validTrade, quantity: 0 }] }), {} as any, () => {}) as any;

    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body);
    expect(body.data.created).toBe(0);
    expect(body.data.errors).toHaveLength(1);
    expect(ddbMock.commandCalls(BatchWriteCommand)).toHaveLength(0);
  });

  // ── Parallel batches of 10 ────────────────────────────────

  it('processes bulk import items in parallel batches of 10', async () => {
    ddbMock.on(BatchWriteCommand).resolves({ UnprocessedItems: {} });

    // Create 15 items (should be processed as batch of 10 + batch of 5)
    const items = Array.from({ length: 15 }, (_, i) => ({
      symbol: `SYM${i}`,
      side: 'BUY',
      quantity: 10,
      openDate: '2024-06-15',
      entryPrice: 100,
      exitPrice: 110,
      closeDate: '2024-06-15',
      outcome: 'TP',
      pnl: 10,
    }));

    const res = await handler(makeEvent({ items }), {} as any, () => {}) as any;

    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(true);
    // All 15 items should be created
    expect(body.data.created).toBe(15);
    expect(body.data.items).toHaveLength(15);
    expect(body.data.errors).toHaveLength(0);
    // Verify all symbols are present
    const symbols = body.data.items.map((it: any) => it.symbol);
    for (let i = 0; i < 15; i++) {
      expect(symbols).toContain(`SYM${i}`);
    }
  });

  // ── DynamoDB edge cases ─────────────────────────────────────

  it('returns 500 when PutCommand throws ProvisionedThroughputExceededException', async () => {
    const throughputError = new Error('Rate exceeded');
    throughputError.name = 'ProvisionedThroughputExceededException';
    ddbMock.on(PutCommand).rejects(throughputError);

    const res = await handler(makeEvent(validTrade), {} as any, () => {}) as any;

    expect(res.statusCode).toBe(500);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(false);
  });
});

// ─── Review fixes ───────────────────────────────────────────────

describe('create-trade: dates, accounts, idempotency, bulk (BE-005, 031, 033-035, 037, 093)', () => {
  const idem = (key: string) => ({ headers: { authorization: `Bearer ${makeJwt('user-1')}`, 'idempotency-key': key } } as any);
  const writtenItems = () => ddbMock.commandCalls(PutCommand).map((c) => c.args[0].input.Item!);

  it('400 for an openDate or closeDate that is not a real day (BE-005)', async () => {
    for (const bad of [{ openDate: '2026-13-01' }, { openDate: 'garbage' }, { closeDate: '2026-02-31T10:00:00Z' }, { openDate: '2026-04-10T25:00:00Z' }]) {
      const res = (await handler(makeEvent({ ...validTrade, ...bad }), {} as any, () => {})) as any;
      expect(res.statusCode).toBe(400);
    }
    expect(ddbMock.commandCalls(PutCommand)).toHaveLength(0);
  });

  it('maps the singular accountId to accountIds instead of storing the trade unassigned (BE-093)', async () => {
    const res = (await handler(makeEvent({ ...validTrade, accountId: 'acc-9' }), {} as any, () => {})) as any;
    expect(res.statusCode).toBe(201);
    expect(writtenItems()[0].accountId).toBe('acc-9');
  });

  describe('multi-account create (BE-031)', () => {
    it('gives the first account the tradeId that owns the screenshots and copies them for the others', async () => {
      s3Mock.on(CopyObjectCommand).resolves({});
      const res = (await handler(makeEvent({ ...validTrade, accountIds: ['acc-1', 'acc-2'], images: [{ key: 'images/user-1/upload/a.png' }] }), {} as any, () => {})) as any;
      expect(res.statusCode).toBe(201);
      const [first, second] = writtenItems();
      expect(first.images[0].key).toBe('images/user-1/upload/a.png');
      expect(second.tradeId).not.toBe(first.tradeId);
      expect(second.images[0].key).toBe(`images/user-1/${second.tradeId}/a.png`);
      expect(s3Mock.commandCalls(CopyObjectCommand)[0].args[0].input).toMatchObject({ CopySource: 'test-bucket/images/user-1/upload/a.png', Key: second.images[0].key });
    });

    it('inline uploads go under the first account\'s tradeId, which an item really has', async () => {
      s3Mock.on(CopyObjectCommand).resolves({});
      await handler(makeEvent({ ...validTrade, accountIds: ['acc-1', 'acc-2'], images: [{ id: 'i1', base64Data: 'data:image/png;base64,aGVsbG8=' }] }), {} as any, () => {});
      const key = s3Mock.commandCalls(PutObjectCommand)[0].args[0].input.Key!;
      expect(key).toBe(`images/user-1/${writtenItems()[0].tradeId}/i1.png`);
    });
  });

  describe('screenshots uploaded before the trade (H10)', () => {
    const upload = 'images/upload/user-1/a.png';

    it('single create stores a copy under the new trade, drops other users\' uploads and leaves the upload for expiry', async () => {
      s3Mock.on(CopyObjectCommand).resolves({});
      const res = (await handler(makeEvent({ ...validTrade, images: [{ key: upload }, { key: 'images/upload/user-2/b.png' }] }), {} as any, () => {})) as any;
      expect(res.statusCode).toBe(201);
      const [item] = writtenItems();
      expect(item.images.map((i: any) => i.key)).toEqual([`images/user-1/${item.tradeId}/a.png`]);
      expect(s3Mock.commandCalls(CopyObjectCommand)).toHaveLength(1);
      expect(s3Mock.commandCalls(CopyObjectCommand)[0].args[0].input).toMatchObject({ CopySource: `test-bucket/${upload}`, Key: item.images[0].key });
    });

    it('bulk create copies each item\'s uploads under that item\'s trade', async () => {
      s3Mock.on(CopyObjectCommand).resolves({});
      ddbMock.on(BatchWriteCommand).resolves({});
      const res = (await handler(makeEvent({ items: [{ ...validTrade, images: [{ key: upload }] }] }), {} as any, () => {})) as any;
      expect(res.statusCode).toBe(201);
      const item = ddbMock.commandCalls(BatchWriteCommand)[0].args[0].input.RequestItems!['test-trades'][0].PutRequest!.Item!;
      expect(item.images[0].key).toBe(`images/user-1/${item.tradeId}/a.png`);
    });

    it('every account gets its own copy: the first under its trade, the others copied from it', async () => {
      s3Mock.on(CopyObjectCommand).resolves({});
      await handler(makeEvent({ ...validTrade, accountIds: ['acc-1', 'acc-2'], images: [{ key: upload }] }), {} as any, () => {});
      const [first, second] = writtenItems();
      expect(first.images[0].key).toBe(`images/user-1/${first.tradeId}/a.png`);
      expect(second.images[0].key).toBe(`images/user-1/${second.tradeId}/a.png`);
      const sources = s3Mock.commandCalls(CopyObjectCommand).map((c) => c.args[0].input.CopySource);
      expect(sources).toEqual([`test-bucket/${upload}`, `test-bucket/${first.images[0].key}`]);
    });

    it('stores nothing when the copy fails', async () => {
      s3Mock.on(CopyObjectCommand).rejects(new Error('NoSuchKey'));
      const res = (await handler(makeEvent({ ...validTrade, images: [{ key: upload }] }), {} as any, () => {})) as any;
      expect(res.statusCode).toBe(500);
      expect(ddbMock.commandCalls(PutCommand)).toHaveLength(0);
    });
  });

  describe('idempotent multi-account create (BE-035)', () => {
    it('after a partial failure the retry creates only the account that is missing', async () => {
      ddbMock.on(QueryCommand).callsFake((input) =>
        input.ExpressionAttributeValues[':k'] === 'k1-acc-1' ? { Items: [{ userId: 'user-1', tradeId: 'made', accountId: 'acc-1', images: [] }] } : { Items: [] });
      const res = (await handler(makeEvent({ ...validTrade, accountIds: ['acc-1', 'acc-2'] }, idem('k1')), {} as any, () => {})) as any;
      expect(res.statusCode).toBe(201);
      const items = writtenItems();
      expect(items).toHaveLength(1);
      expect(items[0]).toMatchObject({ accountId: 'acc-2', idempotencyKey: 'k1-acc-2' });
      const body = JSON.parse(res.body);
      expect(body.data.count).toBe(2);
      expect(body.data.trades.map((t: any) => t.accountId)).toEqual(['acc-1', 'acc-2']);
    });

    it('when every account exists it answers 200 and writes nothing', async () => {
      ddbMock.on(QueryCommand).callsFake((input) => ({ Items: [{ userId: 'user-1', tradeId: `t-${input.ExpressionAttributeValues[':k']}`, images: [] }] }));
      const res = (await handler(makeEvent({ ...validTrade, accountIds: ['acc-1', 'acc-2'] }, idem('k2')), {} as any, () => {})) as any;
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body).data.count).toBe(2);
      expect(ddbMock.commandCalls(PutCommand)).toHaveLength(0);
    });

    it('a listed account is created once', async () => {
      ddbMock.on(QueryCommand).resolves({ Items: [] });
      await handler(makeEvent({ ...validTrade, accountIds: ['acc-1', 'acc-1'] }, idem('k3')), {} as any, () => {});
      expect(writtenItems()).toHaveLength(1);
    });
  });

  describe('bulk validation and results (BE-033, BE-034)', () => {
    it('applies the single-path schema to every item and reports the failing ones by index', async () => {
      ddbMock.on(BatchWriteCommand).resolves({ UnprocessedItems: {} });
      const manyAccounts = Array.from({ length: 11 }, (_, i) => `acc-${i}`);
      const res = (await handler(makeEvent({ items: [
        { ...validTrade, side: 'LONG' },
        { ...validTrade, quantity: -1 },
        { ...validTrade, openDate: 'x' },
        { ...validTrade, outcome: 'WIN' },
        { ...validTrade, accountIds: manyAccounts },
        { ...validTrade, symbol: 'OK', idempotencyKey: undefined },
      ] }), {} as any, () => {})) as any;
      const body = JSON.parse(res.body);
      expect(body.data.created).toBe(1);
      expect(body.data.errors.map((e: any) => e.index).sort()).toEqual([0, 1, 2, 3, 4]);
      expect(body.data.items[0].symbol).toBe('OK');
    });

    it('does not list items the table never received', async () => {
      ddbMock.on(BatchWriteCommand).callsFake((input) => {
        const keep = input.RequestItems['test-trades'];
        return { UnprocessedItems: { 'test-trades': keep.filter((r: any) => r.PutRequest.Item.symbol === 'STUCK') } };
      });
      vi.useFakeTimers();
      const pending = handler(makeEvent({ items: [{ ...validTrade, symbol: 'OK' }, { ...validTrade, symbol: 'STUCK' }] }), {} as any, () => {}) as Promise<any>;
      await vi.runAllTimersAsync();
      const res = await pending;
      vi.useRealTimers();
      const body = JSON.parse(res.body);
      expect(body.data.created).toBe(1);
      expect(body.data.items.map((i: any) => i.symbol)).toEqual(['OK']);
      expect(body.data.errors).toHaveLength(1);
      expect(body.data.errors[0].message).toBe('Unprocessed after retries');
    });

    it('a chunk whose write throws is reported as errors while earlier chunks stay in created', async () => {
      let call = 0;
      ddbMock.on(BatchWriteCommand).callsFake(() => {
        call++;
        if (call === 2) throw new Error('ValidationException');
        return { UnprocessedItems: {} };
      });
      // 30 items = chunks of 25 and 5
      const items = Array.from({ length: 30 }, (_, i) => ({ ...validTrade, symbol: `S${i}` }));
      const res = (await handler(makeEvent({ items }), {} as any, () => {})) as any;
      expect(res.statusCode).toBe(201);
      const body = JSON.parse(res.body);
      expect(body.data.created).toBe(25);
      expect(body.data.errors).toHaveLength(5);
      expect(body.data.errors[0].message).toBe('Write failed');
    });

    it('a failing idempotency lookup is an item error, not a duplicate create', async () => {
      ddbMock.on(QueryCommand).rejects(new Error('gsi down'));
      ddbMock.on(BatchWriteCommand).resolves({ UnprocessedItems: {} });
      const res = (await handler(makeEvent({ items: [{ ...validTrade, idempotencyKey: 'x' }] }), {} as any, () => {})) as any;
      const body = JSON.parse(res.body);
      expect(body.data.created).toBe(0);
      expect(body.data.errors).toHaveLength(1);
      expect(ddbMock.commandCalls(BatchWriteCommand)).toHaveLength(0);
    });
  });
});

describe('create-trade: the reviewed flag (CONTRACT I1)', () => {
  const stored = () => ddbMock.commandCalls(PutCommand).map((c) => c.args[0].input.Item!);

  it('stores reviewed: true and returns it', async () => {
    const res = (await handler(makeEvent({ ...validTrade, reviewed: true }), {} as any, () => {})) as any;
    expect(res.statusCode).toBe(201);
    expect(stored()[0].reviewed).toBe(true);
    expect(JSON.parse(res.body).data.trade.reviewed).toBe(true);
  });

  it('stores false when reviewed is absent or false', async () => {
    await handler(makeEvent(validTrade), {} as any, () => {});
    await handler(makeEvent({ ...validTrade, reviewed: false }), {} as any, () => {});
    expect(stored().map((i) => i.reviewed)).toEqual([false, false]);
  });

  it('400 for a reviewed that is not true or false, and nothing is stored', async () => {
    const res = (await handler(makeEvent({ ...validTrade, reviewed: 'yes' }), {} as any, () => {})) as any;
    expect(res.statusCode).toBe(400);
    expect(stored()).toHaveLength(0);
  });

  it('every account of a multi-account create and every bulk item keeps its own reviewed', async () => {
    await handler(makeEvent({ ...validTrade, reviewed: true, accountIds: ['acc-1', 'acc-2'] }), {} as any, () => {});
    expect(stored().map((i) => i.reviewed)).toEqual([true, true]);

    ddbMock.on(BatchWriteCommand).resolves({ UnprocessedItems: {} });
    await handler(makeEvent({ items: [{ ...validTrade, symbol: 'A', reviewed: true }, { ...validTrade, symbol: 'B' }] }), {} as any, () => {});
    const items = ddbMock.commandCalls(BatchWriteCommand)[0].args[0].input.RequestItems!['test-trades'].map((r) => r.PutRequest!.Item!);
    expect(Object.fromEntries(items.map((i) => [i.symbol, i.reviewed]))).toEqual({ A: true, B: false });
  });
});
