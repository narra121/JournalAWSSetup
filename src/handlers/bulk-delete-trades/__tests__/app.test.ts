import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBDocumentClient, BatchWriteCommand } from '@aws-sdk/lib-dynamodb';
import { S3Client, ListObjectsV2Command, DeleteObjectsCommand } from '@aws-sdk/client-s3';
import type { APIGatewayProxyEventV2 } from 'aws-lambda';

vi.stubEnv('TRADES_TABLE', 'test-trades');
vi.stubEnv('IMAGES_BUCKET', 'test-bucket');

const ddbMock = mockClient(DynamoDBDocumentClient);
const s3Mock = mockClient(S3Client);

const { handler } = await import('../app.ts');

function makeJwt(sub: string): string {
  const header = btoa(JSON.stringify({ alg: 'RS256' }));
  const payload = btoa(JSON.stringify({ sub }));
  return `${header}.${payload}.sig`;
}

function makeEvent(body: any, overrides: Partial<APIGatewayProxyEventV2> = {}): APIGatewayProxyEventV2 {
  return {
    version: '2.0', routeKey: 'POST /trades/bulk-delete', rawPath: '/trades/bulk-delete', rawQueryString: '',
    headers: { authorization: `Bearer ${makeJwt('user-1')}`, ...((overrides as any).headers || {}) },
    requestContext: {
      accountId: '123', apiId: 'api', domainName: 'api.example.com', domainPrefix: 'api',
      http: { method: 'POST', path: '/trades/bulk-delete', protocol: 'HTTP/1.1', sourceIp: '127.0.0.1', userAgent: 'test' },
      requestId: 'req-1', routeKey: 'POST /trades/bulk-delete', stage: '$default',
      time: '01/Jan/2024:00:00:00 +0000', timeEpoch: 0,
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
    isBase64Encoded: false,
    ...overrides,
  } as unknown as APIGatewayProxyEventV2;
}

beforeEach(() => {
  ddbMock.reset();
  s3Mock.reset();
  ddbMock.on(BatchWriteCommand).resolves({ UnprocessedItems: {} });
  s3Mock.on(ListObjectsV2Command).resolves({ Contents: [], IsTruncated: false });
  s3Mock.on(DeleteObjectsCommand).resolves({});
});

describe('bulk-delete-trades handler', () => {
  it('deletes multiple trades and returns 200', async () => {
    const res = await handler(makeEvent({ tradeIds: ['t1', 't2', 't3'] }), {} as any, () => {}) as any;

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(true);
    expect(body.data.deletedRequested).toBe(3);
    expect(body.data.errors).toHaveLength(0);
  });

  it('processes trades in chunks of 25', async () => {
    const ids = Array.from({ length: 30 }, (_, i) => `t${i}`);
    const res = await handler(makeEvent({ tradeIds: ids }), {} as any, () => {}) as any;

    expect(res.statusCode).toBe(200);
    const batchCalls = ddbMock.commandCalls(BatchWriteCommand);
    expect(batchCalls).toHaveLength(2); // 25 + 5
  });

  it('returns errors for unprocessed items after retries', async () => {
    ddbMock.on(BatchWriteCommand).resolves({
      UnprocessedItems: {
        'test-trades': [{ DeleteRequest: { Key: { userId: 'user-1', tradeId: 't1' } } }],
      },
    });

    const res = await handler(makeEvent({ tradeIds: ['t1'] }), {} as any, () => {}) as any;

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.data.errors.length).toBeGreaterThan(0);
  });

  it('returns 401 when unauthorized', async () => {
    const event = makeEvent({ tradeIds: ['t1'] });
    event.headers = {};
    const res = await handler(event, {} as any, () => {}) as any;

    expect(res.statusCode).toBe(401);
  });

  it('returns 400 when body is missing', async () => {
    const event = makeEvent(undefined);
    event.body = undefined;
    const res = await handler(event, {} as any, () => {}) as any;

    expect(res.statusCode).toBe(400);
  });

  it('returns 400 for invalid JSON', async () => {
    const event = makeEvent({ tradeIds: ['t1'] });
    event.body = 'not-json{';
    const res = await handler(event, {} as any, () => {}) as any;

    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).message).toContain('Invalid JSON');
  });

  it('returns 400 when tradeIds is empty', async () => {
    const res = await handler(makeEvent({ tradeIds: [] }), {} as any, () => {}) as any;

    expect(res.statusCode).toBe(400);
  });

  it('returns 400 when tradeIds is not an array', async () => {
    const res = await handler(makeEvent({ tradeIds: 'not-array' }), {} as any, () => {}) as any;

    expect(res.statusCode).toBe(400);
  });

  it('returns 400 when more than 50 tradeIds provided', async () => {
    const ids = Array.from({ length: 51 }, (_, i) => `t${i}`);
    const res = await handler(makeEvent({ tradeIds: ids }), {} as any, () => {}) as any;

    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).message).toContain('Max 50');
  });

  it('returns 500 on unexpected DynamoDB error', async () => {
    ddbMock.on(BatchWriteCommand).rejects(new Error('DynamoDB unavailable'));

    const res = await handler(makeEvent({ tradeIds: ['t1'] }), {} as any, () => {}) as any;

    expect(res.statusCode).toBe(500);
  });

  it('cleans up S3 images for each deleted trade', async () => {
    await handler(makeEvent({ tradeIds: ['t1', 't2'] }), {} as any, () => {});

    const listCalls = s3Mock.commandCalls(ListObjectsV2Command);
    expect(listCalls).toHaveLength(2);
  });
});
