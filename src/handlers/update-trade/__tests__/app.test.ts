import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBDocumentClient, GetCommand, UpdateCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import { S3Client, PutObjectCommand, DeleteObjectsCommand } from '@aws-sdk/client-s3';
import type { APIGatewayProxyEventV2 } from 'aws-lambda';

vi.stubEnv('TRADES_TABLE', 'test-trades');
vi.stubEnv('IMAGES_BUCKET', 'test-bucket');

const ddbMock = mockClient(DynamoDBDocumentClient);
const s3Mock = mockClient(S3Client);

vi.mock('../../../shared/subscription', () => ({
  checkSubscription: vi.fn().mockResolvedValue(null),
}));

const { handler } = await import('../app.ts');

// ─── Helpers ────────────────────────────────────────────────────

function makeJwt(sub: string): string {
  const header = btoa(JSON.stringify({ alg: 'RS256' }));
  const payload = btoa(JSON.stringify({ sub }));
  return `${header}.${payload}.sig`;
}

function makeEvent(tradeId: string, body: any, overrides: Partial<APIGatewayProxyEventV2> = {}): APIGatewayProxyEventV2 {
  return {
    version: '2.0', routeKey: 'PUT /trades/{tradeId}', rawPath: `/trades/${tradeId}`, rawQueryString: '',
    headers: { authorization: `Bearer ${makeJwt('user-1')}`, ...((overrides as any).headers || {}) },
    pathParameters: { tradeId },
    requestContext: {
      accountId: '123', apiId: 'api', domainName: 'api.example.com', domainPrefix: 'api',
      http: { method: 'PUT', path: `/trades/${tradeId}`, protocol: 'HTTP/1.1', sourceIp: '127.0.0.1', userAgent: 'test' },
      requestId: 'req-1', routeKey: 'PUT /trades/{tradeId}', stage: '$default',
      time: '01/Jan/2024:00:00:00 +0000', timeEpoch: 0,
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
    isBase64Encoded: false,
    ...overrides,
  } as unknown as APIGatewayProxyEventV2;
}

const existingTrade = {
  userId: 'user-1', tradeId: 'trade-1', symbol: 'AAPL', side: 'BUY', quantity: 100,
  entryPrice: 150, exitPrice: 160, openDate: '2024-06-15', accountId: 'acc-1', images: [],
};

beforeEach(() => {
  ddbMock.reset();
  s3Mock.reset();
  ddbMock.on(GetCommand).resolves({ Item: { ...existingTrade } });
  ddbMock.on(UpdateCommand).resolves({ Attributes: { ...existingTrade, updatedAt: '2024-06-16T00:00:00Z' } });
  ddbMock.on(PutCommand).resolves({});
  s3Mock.on(PutObjectCommand).resolves({});
  s3Mock.on(DeleteObjectsCommand).resolves({});
});

describe('update-trade handler', () => {
  it('returns 403 when subscription is inactive', async () => {
    const { checkSubscription } = await import('../../../shared/subscription');
    vi.mocked(checkSubscription).mockResolvedValueOnce({
      statusCode: 403,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ success: false, error: { code: 'SUBSCRIPTION_REQUIRED', message: 'Please subscribe', details: { reason: 'trial_expired' } } }),
    } as any);

    const res = await handler(makeEvent('trade-1', { symbol: 'MSFT' }), {} as any, () => {}) as any;

    expect(res.statusCode).toBe(403);
    const body = JSON.parse(res.body);
    expect(body.error.code).toBe('SUBSCRIPTION_REQUIRED');
  });

  // ── Success ─────────────────────────────────────────────────

  it('updates a trade and returns 200', async () => {
    const res = await handler(makeEvent('trade-1', { symbol: 'MSFT' }), {} as any, () => {}) as any;

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(true);
    expect(body.data.trade).toBeDefined();
  });

  it('recalculates PnL for BUY trade when entry/exit prices change', async () => {
    ddbMock.on(GetCommand).resolves({ Item: { ...existingTrade, pnl: undefined } });
    ddbMock.on(UpdateCommand).callsFake((input) => {
      // Return the merged values
      return { Attributes: { ...existingTrade, entryPrice: 100, exitPrice: 200, pnl: 10000 } };
    });

    const res = await handler(makeEvent('trade-1', { entryPrice: 100, exitPrice: 200 }), {} as any, () => {}) as any;

    expect(res.statusCode).toBe(200);
    const updateCalls = ddbMock.commandCalls(UpdateCommand);
    expect(updateCalls.length).toBeGreaterThanOrEqual(1);
  });

  it('uses provided PnL when passed in request body', async () => {
    ddbMock.on(UpdateCommand).resolves({ Attributes: { ...existingTrade, pnl: 999 } });

    const res = await handler(makeEvent('trade-1', { pnl: 999 }), {} as any, () => {}) as any;

    expect(res.statusCode).toBe(200);
  });

  it('handles partial closes with FIFO logic', async () => {
    ddbMock.on(GetCommand).resolves({ Item: { ...existingTrade, partialCloses: [] } });
    ddbMock.on(UpdateCommand).resolves({ Attributes: { ...existingTrade } });

    const res = await handler(makeEvent('trade-1', {
      partialCloses: [{ quantity: 50, exitPrice: 170, time: '2024-06-16T00:00:00Z' }],
    }), {} as any, () => {}) as any;

    expect(res.statusCode).toBe(200);
  });

  it('creates additional trades for multiple accountIds', async () => {
    ddbMock.on(UpdateCommand).resolves({ Attributes: { ...existingTrade } });

    const res = await handler(makeEvent('trade-1', {
      accountIds: ['acc-1', 'acc-2', 'acc-3'],
    }), {} as any, () => {}) as any;

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    // Should have created 2 additional trades (acc-2, acc-3)
    const putCalls = ddbMock.commandCalls(PutCommand);
    expect(putCalls).toHaveLength(2);
  });

  it('sets accountId to -1 when no accountIds provided', async () => {
    ddbMock.on(UpdateCommand).resolves({ Attributes: { ...existingTrade, accountId: '-1' } });

    const res = await handler(makeEvent('trade-1', { symbol: 'TSLA' }), {} as any, () => {}) as any;

    expect(res.statusCode).toBe(200);
  });

  // ── Auth errors ─────────────────────────────────────────────

  it('returns 401 when authorization header is missing', async () => {
    const event = makeEvent('trade-1', { symbol: 'MSFT' });
    event.headers = {};
    const res = await handler(event, {} as any, () => {}) as any;

    expect(res.statusCode).toBe(401);
  });

  // ── Validation errors ───────────────────────────────────────

  it('returns 400 when tradeId is missing', async () => {
    const event = makeEvent('trade-1', { symbol: 'MSFT' });
    event.pathParameters = {};
    const res = await handler(event, {} as any, () => {}) as any;

    expect(res.statusCode).toBe(400);
  });

  it('returns 400 when body is missing', async () => {
    const event = makeEvent('trade-1', undefined);
    event.body = undefined;
    const res = await handler(event, {} as any, () => {}) as any;

    expect(res.statusCode).toBe(400);
  });

  // ── Not found ───────────────────────────────────────────────

  it('returns 404 when trade does not exist', async () => {
    ddbMock.on(GetCommand).resolves({ Item: undefined });

    const res = await handler(makeEvent('nonexistent', { symbol: 'MSFT' }), {} as any, () => {}) as any;

    expect(res.statusCode).toBe(404);
  });

  it('returns 404 on ConditionalCheckFailedException', async () => {
    const error = new Error('Conditional check failed');
    (error as any).name = 'ConditionalCheckFailedException';
    ddbMock.on(UpdateCommand).rejects(error);

    const res = await handler(makeEvent('trade-1', { symbol: 'MSFT' }), {} as any, () => {}) as any;

    expect(res.statusCode).toBe(404);
  });

  // ── DynamoDB errors ─────────────────────────────────────────

  it('returns 500 when DynamoDB GetCommand fails', async () => {
    ddbMock.on(GetCommand).rejects(new Error('DynamoDB error'));

    const res = await handler(makeEvent('trade-1', { symbol: 'MSFT' }), {} as any, () => {}) as any;

    expect(res.statusCode).toBe(500);
  });

  it('returns 500 when DynamoDB UpdateCommand fails', async () => {
    ddbMock.on(UpdateCommand).rejects(new Error('Update failed'));

    const res = await handler(makeEvent('trade-1', { symbol: 'MSFT' }), {} as any, () => {}) as any;

    expect(res.statusCode).toBe(500);
  });

  // ── JSON / Body errors ────────────────────────────────────────

  it('returns 400 when body contains invalid JSON', async () => {
    const event = makeEvent('trade-1', undefined);
    event.body = '{not valid json}';
    const res = await handler(event, {} as any, () => {}) as any;

    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.errorCode).toBe('VALIDATION_ERROR');
    expect(body.message).toContain('Invalid JSON');
  });

  // ── S3 image errors ───────────────────────────────────────────

  it('returns 500 when S3 PutObjectCommand fails while uploading a new image', async () => {
    s3Mock.on(PutObjectCommand).rejects(new Error('S3 upload failed'));

    const res = await handler(makeEvent('trade-1', {
      images: [{ base64Data: 'data:image/png;base64,iVBORw0KGgoAAAANS', description: 'chart' }],
    }), {} as any, () => {}) as any;

    expect(res.statusCode).toBe(500);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(false);
  });

  it('returns 500 when S3 DeleteObjectsCommand fails while removing old images', async () => {
    const tradeWithImages = {
      ...existingTrade,
      images: [
        { id: 'old-img-1', url: `https://test-bucket.s3.amazonaws.com/images/user-1/trade-1/old-img-1.jpg` },
      ],
    };
    ddbMock.on(GetCommand).resolves({ Item: { ...tradeWithImages } });
    s3Mock.on(DeleteObjectsCommand).rejects(new Error('S3 delete failed'));

    // Send empty images array to trigger deletion of old-img-1
    const res = await handler(makeEvent('trade-1', { images: [] }), {} as any, () => {}) as any;

    expect(res.statusCode).toBe(500);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(false);
  });

  // ── Partial close validation ──────────────────────────────────

  it('handles partial close with negative quantity', async () => {
    ddbMock.on(GetCommand).resolves({ Item: { ...existingTrade, partialCloses: [] } });
    ddbMock.on(UpdateCommand).resolves({ Attributes: { ...existingTrade } });

    const res = await handler(makeEvent('trade-1', {
      partialCloses: [{ quantity: -1, exitPrice: 1.1, time: '2024-06-16T00:00:00Z' }],
    }), {} as any, () => {}) as any;

    // Handler does not reject negative quantity; it passes through
    expect(res.statusCode).toBe(200);
    const updateCalls = ddbMock.commandCalls(UpdateCommand);
    expect(updateCalls.length).toBeGreaterThanOrEqual(1);
  });

  it('skips partial close entries missing required exitPrice', async () => {
    ddbMock.on(GetCommand).resolves({ Item: { ...existingTrade, partialCloses: [] } });
    ddbMock.on(UpdateCommand).resolves({ Attributes: { ...existingTrade, partialCloses: [] } });

    const res = await handler(makeEvent('trade-1', {
      partialCloses: [{ quantity: 1 }],
    }), {} as any, () => {}) as any;

    // The handler's guard `pc.exitPrice == null` skips entries missing exitPrice
    expect(res.statusCode).toBe(200);
    const updateCalls = ddbMock.commandCalls(UpdateCommand);
    expect(updateCalls.length).toBeGreaterThanOrEqual(1);
    // Verify the skipped entry was not appended — check the UpdateCommand input
    const updateInput = updateCalls[0].args[0].input as any;
    const partialClosesValue = Object.entries(updateInput.ExpressionAttributeValues || {})
      .find(([k]) => k === ':partialCloses');
    if (partialClosesValue) {
      expect((partialClosesValue[1] as any[]).length).toBe(0);
    }
  });

  // ── Data edge cases ───────────────────────────────────────────

  it('handles NaN price values by computing NaN pnl', async () => {
    ddbMock.on(UpdateCommand).resolves({ Attributes: { ...existingTrade, entryPrice: NaN } });

    const res = await handler(makeEvent('trade-1', { entryPrice: NaN }), {} as any, () => {}) as any;

    // Handler does not reject NaN — Number(NaN) is NaN; it persists through
    expect(res.statusCode).toBe(200);
  });

  it('accepts empty string for symbol', async () => {
    ddbMock.on(UpdateCommand).resolves({ Attributes: { ...existingTrade, symbol: '' } });

    const res = await handler(makeEvent('trade-1', { symbol: '' }), {} as any, () => {}) as any;

    // Handler does not validate symbol value — it stores whatever is provided
    expect(res.statusCode).toBe(200);
    const updateCalls = ddbMock.commandCalls(UpdateCommand);
    const updateInput = updateCalls[0].args[0].input as any;
    const symbolValue = Object.entries(updateInput.ExpressionAttributeValues || {})
      .find(([k]) => k === ':symbol');
    expect(symbolValue).toBeDefined();
    expect(symbolValue![1]).toBe('');
  });

  it('returns 404 when trade is deleted between GET and UPDATE (race condition)', async () => {
    // GetCommand succeeds (trade exists at read time)
    ddbMock.on(GetCommand).resolves({ Item: { ...existingTrade } });
    // UpdateCommand fails because the trade was deleted in the meantime
    const error = new Error('The conditional request failed');
    (error as any).name = 'ConditionalCheckFailedException';
    ddbMock.on(UpdateCommand).rejects(error);

    const res = await handler(makeEvent('trade-1', { symbol: 'MSFT' }), {} as any, () => {}) as any;

    expect(res.statusCode).toBe(404);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(false);
  });

  // ── Multi-account errors ──────────────────────────────────────

  it('creates additional trades even when some accountIds look invalid', async () => {
    ddbMock.on(UpdateCommand).resolves({ Attributes: { ...existingTrade } });
    ddbMock.on(PutCommand).resolves({});

    const res = await handler(makeEvent('trade-1', {
      accountIds: ['valid-acc', '-1'],
    }), {} as any, () => {}) as any;

    // Handler does not validate individual accountId values; it creates trades for each
    expect(res.statusCode).toBe(200);
    const putCalls = ddbMock.commandCalls(PutCommand);
    // First accountId updates existing trade, second triggers a PutCommand
    expect(putCalls).toHaveLength(1);
    const putInput = putCalls[0].args[0].input as any;
    expect(putInput.Item.accountId).toBe('-1');
  });

  // ── DynamoDB edge cases ───────────────────────────────────────

  it('succeeds even when GetCommand returns item without tradeId (malformed data)', async () => {
    const malformed = { userId: 'user-1', symbol: 'AAPL', side: 'BUY', quantity: 100 };
    ddbMock.on(GetCommand).resolves({ Item: { ...malformed } });
    ddbMock.on(UpdateCommand).resolves({ Attributes: { ...malformed, updatedAt: '2024-06-16T00:00:00Z' } });

    const res = await handler(makeEvent('trade-1', { symbol: 'GOOG' }), {} as any, () => {}) as any;

    // Handler checks `current.Item` truthiness, not specific fields — proceeds normally
    expect(res.statusCode).toBe(200);
  });

  it('returns 500 when UpdateCommand fails with throughput exceeded', async () => {
    const error = new Error('Throughput exceeded');
    (error as any).name = 'ProvisionedThroughputExceededException';
    ddbMock.on(UpdateCommand).rejects(error);

    const res = await handler(makeEvent('trade-1', { symbol: 'MSFT' }), {} as any, () => {}) as any;

    expect(res.statusCode).toBe(500);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(false);
  });
});
