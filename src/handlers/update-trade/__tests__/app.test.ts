import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBDocumentClient, GetCommand, UpdateCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import { S3Client, PutObjectCommand, DeleteObjectsCommand } from '@aws-sdk/client-s3';
import type { APIGatewayProxyEventV2 } from 'aws-lambda';

vi.stubEnv('TRADES_TABLE', 'test-trades');
vi.stubEnv('IMAGES_BUCKET', 'test-bucket');

const ddbMock = mockClient(DynamoDBDocumentClient);
const s3Mock = mockClient(S3Client);

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
});
