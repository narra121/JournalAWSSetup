import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBDocumentClient, GetCommand, DeleteCommand } from '@aws-sdk/lib-dynamodb';
import { S3Client, ListObjectsV2Command, DeleteObjectsCommand } from '@aws-sdk/client-s3';
import type { APIGatewayProxyEventV2 } from 'aws-lambda';

// Set up mocks BEFORE importing any handler modules
const ddbMock = mockClient(DynamoDBDocumentClient);
const s3Mock = mockClient(S3Client);

// Mock environment variables before importing handler
vi.stubEnv('TRADES_TABLE', 'test-trades');
vi.stubEnv('IMAGES_BUCKET', 'test-bucket');

// Must import handler after mocks and env stubs are set up
const { handler } = await import('../app.ts');

// ─── Helpers ────────────────────────────────────────────────────

function makeJwt(sub: string): string {
  const header = btoa(JSON.stringify({ alg: 'RS256' }));
  const payload = btoa(JSON.stringify({ sub }));
  return `${header}.${payload}.sig`;
}

function makeEvent(tradeId?: string, overrides: Partial<APIGatewayProxyEventV2> = {}): APIGatewayProxyEventV2 {
  return {
    version: '2.0',
    routeKey: 'DELETE /trades/{tradeId}',
    rawPath: `/trades/${tradeId || ''}`,
    rawQueryString: '',
    headers: {
      authorization: `Bearer ${makeJwt('user-1')}`,
    },
    pathParameters: tradeId ? { tradeId } : {},
    requestContext: {
      accountId: '123',
      apiId: 'api',
      domainName: 'api.example.com',
      domainPrefix: 'api',
      http: { method: 'DELETE', path: `/trades/${tradeId || ''}`, protocol: 'HTTP/1.1', sourceIp: '127.0.0.1', userAgent: 'test' },
      requestId: 'req-1',
      routeKey: 'DELETE /trades/{tradeId}',
      stage: '$default',
      time: '01/Jan/2024:00:00:00 +0000',
      timeEpoch: 0,
    },
    isBase64Encoded: false,
    ...overrides,
  } as unknown as APIGatewayProxyEventV2;
}

const existingTrade = {
  userId: 'user-1',
  tradeId: 'trade-abc',
  symbol: 'AAPL',
  side: 'BUY',
  quantity: 100,
  openDate: '2024-06-15',
  images: [],
};

// ─── Tests ──────────────────────────────────────────────────────

beforeEach(() => {
  ddbMock.reset();
  s3Mock.reset();
  s3Mock.on(ListObjectsV2Command).resolves({ Contents: [], IsTruncated: false });
  s3Mock.on(DeleteObjectsCommand).resolves({});
});

describe('delete-trade handler', () => {
  // ── Success ─────────────────────────────────────────────────

  it('deletes a trade and returns 200 with the deleted trade', async () => {
    ddbMock.on(GetCommand).resolves({ Item: existingTrade });
    ddbMock.on(DeleteCommand).resolves({});

    const res = await handler(makeEvent('trade-abc'), {} as any, () => {}) as any;

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(true);
    expect(body.data.trade.tradeId).toBe('trade-abc');
    expect(body.data.trade.symbol).toBe('AAPL');
  });

  it('calls GetCommand with correct key', async () => {
    ddbMock.on(GetCommand).resolves({ Item: existingTrade });
    ddbMock.on(DeleteCommand).resolves({});

    await handler(makeEvent('trade-abc'), {} as any, () => {});

    const getCalls = ddbMock.commandCalls(GetCommand);
    expect(getCalls).toHaveLength(1);
    expect(getCalls[0].args[0].input.Key).toEqual({ userId: 'user-1', tradeId: 'trade-abc' });
  });

  it('calls DeleteCommand with correct key and condition', async () => {
    ddbMock.on(GetCommand).resolves({ Item: existingTrade });
    ddbMock.on(DeleteCommand).resolves({});

    await handler(makeEvent('trade-abc'), {} as any, () => {});

    const deleteCalls = ddbMock.commandCalls(DeleteCommand);
    expect(deleteCalls).toHaveLength(1);
    expect(deleteCalls[0].args[0].input.Key).toEqual({ userId: 'user-1', tradeId: 'trade-abc' });
    expect(deleteCalls[0].args[0].input.ConditionExpression).toBe('attribute_exists(tradeId)');
  });

  it('cleans up S3 images after deleting trade', async () => {
    ddbMock.on(GetCommand).resolves({ Item: existingTrade });
    ddbMock.on(DeleteCommand).resolves({});
    s3Mock.on(ListObjectsV2Command).resolves({
      Contents: [{ Key: 'images/user-1/trade-abc/img1.jpg' }],
      IsTruncated: false,
    });

    await handler(makeEvent('trade-abc'), {} as any, () => {});

    const listCalls = s3Mock.commandCalls(ListObjectsV2Command);
    expect(listCalls.length).toBeGreaterThanOrEqual(1);
    expect(listCalls[0].args[0].input.Prefix).toBe('images/user-1/trade-abc/');
  });

  // ── Auth errors ─────────────────────────────────────────────

  it('returns 401 when authorization header is missing', async () => {
    const event = makeEvent('trade-abc', { headers: {} });
    const res = await handler(event, {} as any, () => {}) as any;

    expect(res.statusCode).toBe(401);
    const body = JSON.parse(res.body);
    expect(body.errorCode).toBe('UNAUTHORIZED');
  });

  // ── Validation errors ───────────────────────────────────────

  it('returns 400 when tradeId path parameter is missing', async () => {
    const event = makeEvent(undefined);
    event.pathParameters = {};
    const res = await handler(event, {} as any, () => {}) as any;

    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.errorCode).toBe('VALIDATION_ERROR');
  });

  // ── Not found ───────────────────────────────────────────────

  it('returns 404 when trade does not exist', async () => {
    ddbMock.on(GetCommand).resolves({ Item: undefined });

    const res = await handler(makeEvent('nonexistent-trade'), {} as any, () => {}) as any;

    expect(res.statusCode).toBe(404);
    const body = JSON.parse(res.body);
    expect(body.errorCode).toBe('TRADE_NOT_FOUND');
  });

  it('returns 404 when delete ConditionalCheckFailedException occurs', async () => {
    ddbMock.on(GetCommand).resolves({ Item: existingTrade });
    const error = new Error('The conditional request failed');
    (error as any).name = 'ConditionalCheckFailedException';
    ddbMock.on(DeleteCommand).rejects(error);

    const res = await handler(makeEvent('trade-abc'), {} as any, () => {}) as any;

    expect(res.statusCode).toBe(404);
    const body = JSON.parse(res.body);
    expect(body.errorCode).toBe('TRADE_NOT_FOUND');
  });

  // ── DynamoDB errors ─────────────────────────────────────────

  it('returns 500 when DynamoDB GetCommand fails unexpectedly', async () => {
    ddbMock.on(GetCommand).rejects(new Error('DynamoDB error'));

    const res = await handler(makeEvent('trade-abc'), {} as any, () => {}) as any;

    expect(res.statusCode).toBe(500);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(false);
    expect(body.errorCode).toBe('INTERNAL_ERROR');
  });

  it('returns 500 when DynamoDB DeleteCommand fails unexpectedly', async () => {
    ddbMock.on(GetCommand).resolves({ Item: existingTrade });
    ddbMock.on(DeleteCommand).rejects(new Error('Unexpected delete error'));

    const res = await handler(makeEvent('trade-abc'), {} as any, () => {}) as any;

    expect(res.statusCode).toBe(500);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(false);
  });

  // ── S3 image cleanup ───────────────────────────────────────

  it('deletes multiple S3 images when trade has several images', async () => {
    ddbMock.on(GetCommand).resolves({ Item: existingTrade });
    ddbMock.on(DeleteCommand).resolves({});
    s3Mock.on(ListObjectsV2Command).resolves({
      Contents: [
        { Key: 'images/user-1/trade-abc/img1.jpg' },
        { Key: 'images/user-1/trade-abc/img2.png' },
        { Key: 'images/user-1/trade-abc/img3.webp' },
      ],
      IsTruncated: false,
    });

    await handler(makeEvent('trade-abc'), {} as any, () => {});

    const deleteCalls = s3Mock.commandCalls(DeleteObjectsCommand);
    expect(deleteCalls).toHaveLength(1);
    expect(deleteCalls[0].args[0].input.Delete?.Objects).toHaveLength(3);
  });

  it('handles S3 pagination when trade has many images', async () => {
    ddbMock.on(GetCommand).resolves({ Item: existingTrade });
    ddbMock.on(DeleteCommand).resolves({});
    s3Mock.on(ListObjectsV2Command)
      .resolvesOnce({
        Contents: [{ Key: 'images/user-1/trade-abc/img1.jpg' }],
        IsTruncated: true,
        NextContinuationToken: 'token1',
      })
      .resolvesOnce({
        Contents: [{ Key: 'images/user-1/trade-abc/img2.jpg' }],
        IsTruncated: false,
      });

    await handler(makeEvent('trade-abc'), {} as any, () => {});

    const listCalls = s3Mock.commandCalls(ListObjectsV2Command);
    expect(listCalls).toHaveLength(2);
    expect(listCalls[1].args[0].input.ContinuationToken).toBe('token1');

    // All keys collected first, then deleted in a single batch (total < 1000)
    const deleteCalls = s3Mock.commandCalls(DeleteObjectsCommand);
    expect(deleteCalls).toHaveLength(1);
  });

  it('still deletes trade even when S3 has no images', async () => {
    ddbMock.on(GetCommand).resolves({ Item: existingTrade });
    ddbMock.on(DeleteCommand).resolves({});
    s3Mock.on(ListObjectsV2Command).resolves({ Contents: [], IsTruncated: false });

    const res = await handler(makeEvent('trade-abc'), {} as any, () => {}) as any;

    expect(res.statusCode).toBe(200);
    const deleteCalls = s3Mock.commandCalls(DeleteObjectsCommand);
    expect(deleteCalls).toHaveLength(0);
  });
});
