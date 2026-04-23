import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBDocumentClient, QueryCommand, BatchGetCommand } from '@aws-sdk/lib-dynamodb';
import type { APIGatewayProxyEventV2 } from 'aws-lambda';

// Mock environment variables before importing handler
vi.stubEnv('TRADES_TABLE', 'test-trades');
vi.stubEnv('IMAGES_BUCKET', 'test-bucket');

// Must import handler after env stubs
const { handler } = await import('../app.ts');

const ddbMock = mockClient(DynamoDBDocumentClient);

// ─── Helpers ────────────────────────────────────────────────────

function makeEvent(overrides: Partial<APIGatewayProxyEventV2> = {}): APIGatewayProxyEventV2 {
  return {
    version: '2.0',
    routeKey: 'GET /admin/users/{userId}/trades',
    rawPath: '/admin/users/user-1/trades',
    rawQueryString: '',
    headers: {},
    pathParameters: {
      userId: 'user-1',
    },
    requestContext: {
      accountId: '123',
      apiId: 'api',
      domainName: 'api.example.com',
      domainPrefix: 'api',
      http: { method: 'GET', path: '/admin/users/user-1/trades', protocol: 'HTTP/1.1', sourceIp: '127.0.0.1', userAgent: 'test' },
      requestId: 'req-1',
      routeKey: 'GET /admin/users/{userId}/trades',
      stage: '$default',
      time: '01/Jan/2024:00:00:00 +0000',
      timeEpoch: 0,
    },
    queryStringParameters: {
      accountId: 'acc-1',
      startDate: '2024-01-01',
      endDate: '2024-12-31',
    },
    isBase64Encoded: false,
    ...overrides,
  } as APIGatewayProxyEventV2;
}

// ─── Tests ──────────────────────────────────────────────────────

beforeEach(() => {
  ddbMock.reset();
});

describe('admin-list-user-trades handler', () => {
  it('returns 400 when userId path parameter is missing', async () => {
    const event = makeEvent({ pathParameters: {} });
    const res = await handler(event, {} as any, () => {}) as any;

    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(false);
    expect(body.errorCode).toBe('VALIDATION_ERROR');
    expect(body.message).toContain('userId');
  });

  it('returns 400 when pathParameters is undefined', async () => {
    const event = makeEvent({ pathParameters: undefined });
    const res = await handler(event, {} as any, () => {}) as any;

    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(false);
    expect(body.errorCode).toBe('VALIDATION_ERROR');
  });

  it('returns trades for specified userId with pagination metadata', async () => {
    const gsiKeys = [
      { userId: 'user-1', tradeId: 't1', openDate: '2024-01-10' },
      { userId: 'user-1', tradeId: 't2', openDate: '2024-02-15' },
    ];
    const fullItems = [
      { userId: 'user-1', tradeId: 't1', symbol: 'AAPL', side: 'BUY', openDate: '2024-01-10', accountId: 'acc-1', images: [] },
      { userId: 'user-1', tradeId: 't2', symbol: 'MSFT', side: 'SELL', openDate: '2024-02-15', accountId: 'acc-1', images: [] },
    ];
    ddbMock.on(QueryCommand).resolves({ Items: gsiKeys });
    ddbMock.on(BatchGetCommand).resolves({ Responses: { 'test-trades': fullItems } });

    const res = await handler(makeEvent(), {} as any, () => {}) as any;

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(true);
    expect(body.data.trades).toHaveLength(2);
    expect(body.data.trades[0].symbol).toBe('AAPL');
    expect(body.data.pagination).toBeDefined();
    expect(body.data.pagination.hasMore).toBe(false);
    expect(body.data.pagination.nextCursor).toBeNull();
    expect(body.data.pagination.limit).toBe(50);
  });

  it('returns empty list when no trades exist', async () => {
    ddbMock.on(QueryCommand).resolves({ Items: [] });

    const res = await handler(makeEvent(), {} as any, () => {}) as any;

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.data.trades).toEqual([]);
    expect(body.data.pagination.hasMore).toBe(false);
    expect(body.data.pagination.nextCursor).toBeNull();
  });

  it('returns 400 when accountId query param is missing', async () => {
    const event = makeEvent({
      queryStringParameters: {
        startDate: '2024-01-01',
        endDate: '2024-12-31',
      },
    });
    const res = await handler(event, {} as any, () => {}) as any;

    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.errorCode).toBe('VALIDATION_ERROR');
    expect(body.message).toContain('accountId');
  });

  it('returns 400 when date params are missing', async () => {
    const event = makeEvent({
      queryStringParameters: {
        accountId: 'acc-1',
      },
    });
    const res = await handler(event, {} as any, () => {}) as any;

    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.errorCode).toBe('VALIDATION_ERROR');
    expect(body.message).toContain('startDate');
  });

  it('returns nextCursor and hasMore when DynamoDB returns LastEvaluatedKey', async () => {
    const lastKey = { userId: 'user-1', tradeId: 't5' };
    const gsiKeys = [{ userId: 'user-1', tradeId: 't5', openDate: '2024-06-01' }];
    const fullItems = [{ userId: 'user-1', tradeId: 't5', symbol: 'TSLA', accountId: 'acc-1', images: [] }];
    ddbMock.on(QueryCommand).resolves({
      Items: gsiKeys,
      LastEvaluatedKey: lastKey,
    });
    ddbMock.on(BatchGetCommand).resolves({ Responses: { 'test-trades': fullItems } });

    const res = await handler(makeEvent(), {} as any, () => {}) as any;

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.data.pagination.hasMore).toBe(true);
    expect(body.data.pagination.nextCursor).toBeDefined();
    expect(body.data.pagination.limit).toBe(50);
    // Decode the nextCursor and verify it matches the LastEvaluatedKey
    const decoded = JSON.parse(Buffer.from(body.data.pagination.nextCursor, 'base64').toString('utf-8'));
    expect(decoded).toEqual(lastKey);
    // Backward compat: nextToken still present
    expect(body.data.nextToken).toBe(body.data.pagination.nextCursor);
  });

  it('handles DynamoDB errors gracefully', async () => {
    ddbMock.on(QueryCommand).rejects(new Error('DynamoDB timeout'));

    const res = await handler(makeEvent(), {} as any, () => {}) as any;

    expect(res.statusCode).toBe(500);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(false);
    expect(body.errorCode).toBe('INTERNAL_ERROR');
  });

  it('normalizes image keys in trade items', async () => {
    const gsiKeys = [
      { userId: 'user-1', tradeId: 't1', openDate: '2024-01-10' },
    ];
    const fullItems = [
      {
        userId: 'user-1',
        tradeId: 't1',
        symbol: 'AAPL',
        accountId: 'acc-1',
        images: [{ key: 'images/user-1/t1/img1.jpg', timeframe: '1h' }],
      },
    ];
    ddbMock.on(QueryCommand).resolves({ Items: gsiKeys });
    ddbMock.on(BatchGetCommand).resolves({ Responses: { 'test-trades': fullItems } });

    const res = await handler(makeEvent(), {} as any, () => {}) as any;

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    const img = body.data.trades[0].images[0];
    expect(img.id).toBe('images/user-1/t1/img1.jpg');
    expect(img.key).toBe('images/user-1/t1/img1.jpg');
  });

  it('queries with accountId=ALL skips account filtering', async () => {
    ddbMock.on(QueryCommand).resolves({ Items: [] });

    const event = makeEvent({
      queryStringParameters: {
        accountId: 'ALL',
        startDate: '2024-01-01',
        endDate: '2024-12-31',
      },
    });
    await handler(event, {} as any, () => {}) as any;

    // Verify the query was sent - it should NOT have a FilterExpression for accountId
    const call = ddbMock.commandCalls(QueryCommand)[0];
    expect(call.args[0].input.FilterExpression).toBeUndefined();
  });

  it('returns 400 for invalid cursor format', async () => {
    const event = makeEvent({
      queryStringParameters: {
        accountId: 'acc-1',
        startDate: '2024-01-01',
        endDate: '2024-12-31',
        cursor: '!!!invalid!!!',
      },
    });
    const res = await handler(event, {} as any, () => {}) as any;

    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(false);
    expect(body.errorCode).toBe('VALIDATION_ERROR');
    expect(body.message).toContain('cursor');
  });

  it('uses the userId from path parameters in DynamoDB query', async () => {
    ddbMock.on(QueryCommand).resolves({ Items: [] });

    const event = makeEvent({
      pathParameters: { userId: 'target-user-42' },
    });
    await handler(event, {} as any, () => {}) as any;

    const call = ddbMock.commandCalls(QueryCommand)[0];
    expect(call.args[0].input.ExpressionAttributeValues![':u']).toBe('target-user-42');
  });

  it('caps very large page size parameter to 100', async () => {
    ddbMock.on(QueryCommand).resolves({ Items: [] });

    const event = makeEvent({
      queryStringParameters: {
        accountId: 'acc-1',
        startDate: '2024-01-01',
        endDate: '2024-12-31',
        limit: '9999',
      },
    });
    const res = await handler(event, {} as any, () => {}) as any;

    const body = JSON.parse(res.body);
    expect(body.data.pagination.limit).toBe(100);
  });

  it('defaults limit to 50 when not provided', async () => {
    ddbMock.on(QueryCommand).resolves({ Items: [] });

    const res = await handler(makeEvent(), {} as any, () => {}) as any;

    const body = JSON.parse(res.body);
    expect(body.data.pagination.limit).toBe(50);
  });
});
