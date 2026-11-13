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

  describe('paging (BE-071)', () => {
    const key = (i: number) => ({ userId: 'user-1', tradeId: `t${i}`, openDate: `2024-03-${String(i).padStart(2, '0')}T10:00:00Z` });
    const full = (i: number, accountId = 'acc-1') => ({ ...key(i), symbol: `S${i}`, accountId, images: [] });
    const range = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, n) => from + n);
    const decode = (c: string) => JSON.parse(Buffer.from(c, 'base64').toString('utf-8'));
    const event = (extra: Record<string, string> = {}) =>
      makeEvent({ queryStringParameters: { accountId: 'acc-1', startDate: '2024-01-01', endDate: '2024-12-31', ...extra } as any });

    it('continues after the last trade RETURNED, so trimmed trades are not skipped', async () => {
      // 8 matching trades read in one index page, limit 5: the cursor must point at t5, not at the end of the page (t8)
      ddbMock.on(QueryCommand).resolves({ Items: range(1, 8).map(key), LastEvaluatedKey: key(8) });
      ddbMock.on(BatchGetCommand).resolves({ Responses: { 'test-trades': range(1, 8).map((i) => full(i)) } });

      const res = (await handler(event({ limit: '5' }), {} as any, () => {})) as any;
      const body = JSON.parse(res.body);

      expect(body.data.trades.map((t: any) => t.tradeId)).toEqual(['t1', 't2', 't3', 't4', 't5']);
      expect(body.data.pagination.hasMore).toBe(true);
      expect(decode(body.data.pagination.nextCursor)).toEqual(key(5));
    });

    it('trims the ALL path to the limit as well', async () => {
      ddbMock.on(QueryCommand).resolves({ Items: range(1, 8).map(key), LastEvaluatedKey: key(8) });
      ddbMock.on(BatchGetCommand).resolves({ Responses: { 'test-trades': range(1, 8).map((i) => full(i)) } });

      const res = (await handler(event({ accountId: 'ALL', limit: '5' }), {} as any, () => {})) as any;
      const body = JSON.parse(res.body);

      expect(body.data.trades).toHaveLength(5);
      expect(decode(body.data.pagination.nextCursor)).toEqual(key(5));
      expect(ddbMock.commandCalls(QueryCommand)[0].args[0].input.Limit).toBe(5);
    });

    it('reads three index pages per requested trade only when filtering by one account', async () => {
      ddbMock.on(QueryCommand).resolves({ Items: [] });
      await handler(event({ limit: '10' }), {} as any, () => {});
      expect(ddbMock.commandCalls(QueryCommand)[0].args[0].input.Limit).toBe(30);
    });

    it('fills the page from the next index page, and the cursor still follows the last returned trade', async () => {
      ddbMock
        .on(QueryCommand)
        .resolvesOnce({ Items: [key(1), key(2)], LastEvaluatedKey: key(2) })
        .resolvesOnce({ Items: range(3, 6).map(key), LastEvaluatedKey: key(6) });
      ddbMock.on(BatchGetCommand).callsFake((input) => ({
        Responses: { 'test-trades': input.RequestItems['test-trades'].Keys.map((k: any) => full(Number(k.tradeId.slice(1)), Number(k.tradeId.slice(1)) === 1 ? 'other' : 'acc-1')) },
      }));

      const res = (await handler(event({ limit: '3' }), {} as any, () => {})) as any;
      const body = JSON.parse(res.body);

      expect(body.data.trades.map((t: any) => t.tradeId)).toEqual(['t2', 't3', 't4']);
      expect(ddbMock.commandCalls(QueryCommand)[1].args[0].input.ExclusiveStartKey).toEqual(key(2));
      expect(decode(body.data.pagination.nextCursor)).toEqual(key(4));
    });

    it('retries unprocessed BatchGet keys in the fill pages too, and fails instead of dropping them silently', async () => {
      ddbMock
        .on(QueryCommand)
        .resolvesOnce({ Items: [key(1)], LastEvaluatedKey: key(1) })
        .resolvesOnce({ Items: [key(2)] });
      ddbMock
        .on(BatchGetCommand)
        .resolvesOnce({ Responses: { 'test-trades': [full(1)] } })
        .resolvesOnce({ Responses: { 'test-trades': [] }, UnprocessedKeys: { 'test-trades': { Keys: [{ userId: 'user-1', tradeId: 't2' }] } } })
        .resolves({ Responses: { 'test-trades': [full(2)] } });

      const res = (await handler(event({ limit: '5' }), {} as any, () => {})) as any;

      expect(JSON.parse(res.body).data.trades.map((t: any) => t.tradeId)).toEqual(['t1', 't2']);
    });

    it('answers 500 when keys stay unprocessed after the retries', async () => {
      ddbMock.on(QueryCommand).resolves({ Items: [key(1)] });
      ddbMock.on(BatchGetCommand).resolves({ Responses: { 'test-trades': [] }, UnprocessedKeys: { 'test-trades': { Keys: [{ userId: 'user-1', tradeId: 't1' }] } } });

      const res = (await handler(event(), {} as any, () => {})) as any;

      expect(res.statusCode).toBe(500);
    });

    it.each([['abc'], [''], ['NaN']])('limit=%s falls back to 50 instead of sending Limit NaN', async (limit) => {
      ddbMock.on(QueryCommand).resolves({ Items: [] });
      const res = (await handler(event({ limit }), {} as any, () => {})) as any;
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body).data.pagination.limit).toBe(50);
      expect(ddbMock.commandCalls(QueryCommand)[0].args[0].input.Limit).toBe(150);
    });

    it('skips soft-deleted trades', async () => {
      ddbMock.on(QueryCommand).resolves({ Items: [key(1), key(2)] });
      ddbMock.on(BatchGetCommand).resolves({ Responses: { 'test-trades': [full(1), { ...full(2), deletedAt: '2024-04-01T00:00:00Z' }] } });
      const res = (await handler(event(), {} as any, () => {})) as any;
      expect(JSON.parse(res.body).data.trades.map((t: any) => t.tradeId)).toEqual(['t1']);
    });
  });

  it('defaults limit to 50 when not provided', async () => {
    ddbMock.on(QueryCommand).resolves({ Items: [] });

    const res = await handler(makeEvent(), {} as any, () => {}) as any;

    const body = JSON.parse(res.body);
    expect(body.data.pagination.limit).toBe(50);
  });
});
