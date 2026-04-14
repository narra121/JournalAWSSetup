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

function makeJwt(sub: string): string {
  const header = btoa(JSON.stringify({ alg: 'RS256' }));
  const payload = btoa(JSON.stringify({ sub }));
  return `${header}.${payload}.sig`;
}

function makeEvent(overrides: Partial<APIGatewayProxyEventV2> = {}): APIGatewayProxyEventV2 {
  return {
    version: '2.0',
    routeKey: 'GET /trades',
    rawPath: '/trades',
    rawQueryString: '',
    headers: {
      authorization: `Bearer ${makeJwt('user-1')}`,
    },
    requestContext: {
      accountId: '123',
      apiId: 'api',
      domainName: 'api.example.com',
      domainPrefix: 'api',
      http: { method: 'GET', path: '/trades', protocol: 'HTTP/1.1', sourceIp: '127.0.0.1', userAgent: 'test' },
      requestId: 'req-1',
      routeKey: 'GET /trades',
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

describe('list-trades handler', () => {
  it('returns trades for authenticated user with pagination metadata', async () => {
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
    // Pagination metadata present with defaults
    expect(body.data.pagination).toBeDefined();
    expect(body.data.pagination.hasMore).toBe(false);
    expect(body.data.pagination.nextCursor).toBeNull();
    expect(body.data.pagination.limit).toBe(50);
  });

  it('returns empty list when no trades exist with pagination', async () => {
    ddbMock.on(QueryCommand).resolves({ Items: [] });

    const res = await handler(makeEvent(), {} as any, () => {}) as any;

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.data.trades).toEqual([]);
    expect(body.data.pagination.hasMore).toBe(false);
    expect(body.data.pagination.nextCursor).toBeNull();
  });

  it('returns 401 when authorization header is missing', async () => {
    const event = makeEvent({ headers: {} });
    const res = await handler(event, {} as any, () => {}) as any;

    expect(res.statusCode).toBe(401);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(false);
    expect(body.errorCode).toBe('UNAUTHORIZED');
  });

  it('returns 400 when accountId is missing', async () => {
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
    // New pagination object
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

  // ─── Additional error / edge-case tests ────────────────────────

  it('returns 400 for invalid cursor format (malformed base64)', async () => {
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

  it('returns 400 for invalid nextToken format (backward compat)', async () => {
    const event = makeEvent({
      queryStringParameters: {
        accountId: 'acc-1',
        startDate: '2024-01-01',
        endDate: '2024-12-31',
        nextToken: '!!!invalid!!!',
      },
    });
    const res = await handler(event, {} as any, () => {}) as any;

    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(false);
    expect(body.errorCode).toBe('VALIDATION_ERROR');
  });

  it('does not crash when DynamoDB returns items with missing required fields', async () => {
    const gsiKeys = [
      { userId: 'user-1', tradeId: 't1', openDate: '2024-01-01' },
      { userId: 'user-1', tradeId: 't2', openDate: '2024-01-02' },
      { userId: 'user-1', tradeId: 't3', openDate: '2024-01-03' },
    ];
    const fullItems = [
      { userId: 'user-1', tradeId: 't1', accountId: 'acc-1' },           // no symbol
      { userId: 'user-1', tradeId: 't2', accountId: 'acc-1' },           // no symbol
      { userId: 'user-1', tradeId: 't3', symbol: 'AAPL', accountId: 'acc-1' },
    ];
    ddbMock.on(QueryCommand).resolves({ Items: gsiKeys });
    ddbMock.on(BatchGetCommand).resolves({ Responses: { 'test-trades': fullItems } });

    const res = await handler(makeEvent(), {} as any, () => {}) as any;

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(true);
    expect(body.data.trades).toHaveLength(3);
  });

  it('accountId=ALL uses correct key condition without accountId filter', async () => {
    const items = [
      { userId: 'user-1', tradeId: 't1', symbol: 'AAPL', accountId: 'acc-1', images: [] },
      { userId: 'user-1', tradeId: 't2', symbol: 'MSFT', accountId: 'acc-2', images: [] },
    ];
    ddbMock.on(QueryCommand).resolves({ Items: items });
    ddbMock.on(BatchGetCommand).resolves({ Responses: { 'test-trades': items } });

    const event = makeEvent({
      queryStringParameters: {
        accountId: 'ALL',
        startDate: '2024-01-01',
        endDate: '2024-12-31',
      },
    });
    const res = await handler(event, {} as any, () => {}) as any;

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.data.trades).toHaveLength(2);

    // Verify no FilterExpression and no :aid in ExpressionAttributeValues
    const call = ddbMock.commandCalls(QueryCommand)[0];
    expect(call.args[0].input.FilterExpression).toBeUndefined();
    expect(call.args[0].input.ExpressionAttributeValues).not.toHaveProperty(':aid');
  });

  it('returns 500 when DynamoDB QueryCommand rejects during date range query', async () => {
    ddbMock.on(QueryCommand).rejects(new Error('Provisioned throughput exceeded'));

    const event = makeEvent({
      queryStringParameters: {
        accountId: 'acc-1',
        startDate: '2024-01-01',
        endDate: '2024-12-31',
      },
    });
    const res = await handler(event, {} as any, () => {}) as any;

    expect(res.statusCode).toBe(500);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(false);
    expect(body.errorCode).toBe('INTERNAL_ERROR');
  });

  it('returns trade without image URLs when image has no valid key', async () => {
    const gsiKeys = [
      { userId: 'user-1', tradeId: 't1', openDate: '2024-01-10' },
    ];
    const fullItems = [
      {
        userId: 'user-1',
        tradeId: 't1',
        symbol: 'AAPL',
        accountId: 'acc-1',
        images: [{ url: 'not-a-valid-s3-url' }],
      },
    ];
    ddbMock.on(QueryCommand).resolves({ Items: gsiKeys });
    ddbMock.on(BatchGetCommand).resolves({ Responses: { 'test-trades': fullItems } });

    const res = await handler(makeEvent(), {} as any, () => {}) as any;

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.data.trades).toHaveLength(1);
    // Image should still be returned but without a valid key
    const img = body.data.trades[0].images[0];
    expect(img.id).toBeDefined();
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

    // Verify the response pagination limit is capped at 100
    const body = JSON.parse(res.body);
    expect(body.data.pagination.limit).toBe(100);
  });

  it('handles startDate after endDate without error (DDB BETWEEN)', async () => {
    ddbMock.on(QueryCommand).resolves({ Items: [] });

    const event = makeEvent({
      queryStringParameters: {
        accountId: 'acc-1',
        startDate: '2026-12-31',
        endDate: '2026-01-01',
      },
    });
    const res = await handler(event, {} as any, () => {}) as any;

    // DynamoDB BETWEEN with start > end returns no results but doesn't error
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(true);
    expect(body.data.trades).toEqual([]);
  });

  // ─── Cursor-based pagination tests ─────────────────────────────

  it('passes custom limit to DynamoDB QueryCommand', async () => {
    ddbMock.on(QueryCommand).resolves({ Items: [] });

    const event = makeEvent({
      queryStringParameters: {
        accountId: 'acc-1',
        startDate: '2024-01-01',
        endDate: '2024-12-31',
        limit: '25',
      },
    });
    const res = await handler(event, {} as any, () => {}) as any;

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.data.pagination.limit).toBe(25);

    // GSI path over-fetches with Limit = limit * 3 to account for post-filtering
    const call = ddbMock.commandCalls(QueryCommand)[0];
    expect(call.args[0].input.Limit).toBe(75);
  });

  it('defaults limit to 50 when not provided', async () => {
    ddbMock.on(QueryCommand).resolves({ Items: [] });

    const res = await handler(makeEvent(), {} as any, () => {}) as any;

    // Verify default pagination limit in response
    const body = JSON.parse(res.body);
    expect(body.data.pagination.limit).toBe(50);
  });

  it('clamps limit below 1 to 1', async () => {
    ddbMock.on(QueryCommand).resolves({ Items: [] });

    const event = makeEvent({
      queryStringParameters: {
        accountId: 'acc-1',
        startDate: '2024-01-01',
        endDate: '2024-12-31',
        limit: '0',
      },
    });
    const res = await handler(event, {} as any, () => {}) as any;

    // Verify clamping in pagination response
    const body = JSON.parse(res.body);
    expect(body.data.pagination.limit).toBe(1);
  });

  it('passes decoded cursor as ExclusiveStartKey to DynamoDB', async () => {
    const lastKey = { userId: 'user-1', openDate: '2024-06-15', tradeId: 't10' };
    const encodedCursor = Buffer.from(JSON.stringify(lastKey)).toString('base64');

    ddbMock.on(QueryCommand).resolves({ Items: [] });

    const event = makeEvent({
      queryStringParameters: {
        accountId: 'acc-1',
        startDate: '2024-01-01',
        endDate: '2024-12-31',
        cursor: encodedCursor,
      },
    });
    await handler(event, {} as any, () => {}) as any;

    const call = ddbMock.commandCalls(QueryCommand)[0];
    expect(call.args[0].input.ExclusiveStartKey).toEqual(lastKey);
  });

  it('simulates multi-page traversal using cursor', async () => {
    const page1Key = { userId: 'user-1', openDate: '2024-03-01', tradeId: 't2' };

    const page1GsiKeys = [
      { userId: 'user-1', tradeId: 't1', openDate: '2024-01-15' },
      { userId: 'user-1', tradeId: 't2', openDate: '2024-03-01' },
    ];
    const page1FullItems = [
      { userId: 'user-1', tradeId: 't1', symbol: 'AAPL', accountId: 'acc-1', images: [] },
      { userId: 'user-1', tradeId: 't2', symbol: 'MSFT', accountId: 'acc-1', images: [] },
    ];
    const page2GsiKeys = [
      { userId: 'user-1', tradeId: 't3', openDate: '2024-05-01' },
    ];
    const page2FullItems = [
      { userId: 'user-1', tradeId: 't3', symbol: 'TSLA', accountId: 'acc-1', images: [] },
    ];

    // Page 1: returns LastEvaluatedKey
    ddbMock.on(QueryCommand).resolvesOnce({
      Items: page1GsiKeys,
      LastEvaluatedKey: page1Key,
    }).resolvesOnce({
      // Page 2: no LastEvaluatedKey (last page)
      Items: page2GsiKeys,
    });
    ddbMock.on(BatchGetCommand).resolvesOnce({
      Responses: { 'test-trades': page1FullItems },
    }).resolvesOnce({
      Responses: { 'test-trades': page2FullItems },
    });

    // Fetch page 1
    const res1 = await handler(makeEvent({
      queryStringParameters: {
        accountId: 'acc-1',
        startDate: '2024-01-01',
        endDate: '2024-12-31',
        limit: '2',
      },
    }), {} as any, () => {}) as any;

    const body1 = JSON.parse(res1.body);
    expect(body1.data.trades).toHaveLength(2);
    expect(body1.data.pagination.hasMore).toBe(true);
    expect(body1.data.pagination.nextCursor).toBeDefined();

    // Fetch page 2 using cursor from page 1
    const res2 = await handler(makeEvent({
      queryStringParameters: {
        accountId: 'acc-1',
        startDate: '2024-01-01',
        endDate: '2024-12-31',
        limit: '2',
        cursor: body1.data.pagination.nextCursor,
      },
    }), {} as any, () => {}) as any;

    const body2 = JSON.parse(res2.body);
    expect(body2.data.trades).toHaveLength(1);
    expect(body2.data.pagination.hasMore).toBe(false);
    expect(body2.data.pagination.nextCursor).toBeNull();

    // Verify the second call used the ExclusiveStartKey from page 1
    const calls = ddbMock.commandCalls(QueryCommand);
    expect(calls[1].args[0].input.ExclusiveStartKey).toEqual(page1Key);
  });

  it('pagination object has correct shape when there are no more pages', async () => {
    const items = [{ userId: 'user-1', tradeId: 't1', symbol: 'AAPL', images: [] }];
    ddbMock.on(QueryCommand).resolves({
      Items: items,
      // No LastEvaluatedKey
    });
    ddbMock.on(BatchGetCommand).resolves({ Responses: { 'test-trades': items } });

    const res = await handler(makeEvent(), {} as any, () => {}) as any;
    const body = JSON.parse(res.body);

    expect(body.data.pagination).toEqual({
      nextCursor: null,
      hasMore: false,
      limit: 50,
    });
  });
});
