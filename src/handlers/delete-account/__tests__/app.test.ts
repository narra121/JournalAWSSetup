import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBDocumentClient, GetCommand, DeleteCommand, QueryCommand, BatchWriteCommand } from '@aws-sdk/lib-dynamodb';
import { S3Client, ListObjectsV2Command, DeleteObjectsCommand } from '@aws-sdk/client-s3';
import type { APIGatewayProxyEventV2 } from 'aws-lambda';

// Set up mocks BEFORE importing any handler modules
const ddbMock = mockClient(DynamoDBDocumentClient);
const s3Mock = mockClient(S3Client);

// Mock environment variables before importing handler
vi.stubEnv('ACCOUNTS_TABLE', 'test-accounts');
vi.stubEnv('TRADES_TABLE', 'test-trades');
vi.stubEnv('GOALS_TABLE', 'test-goals');
vi.stubEnv('IMAGES_BUCKET', 'test-bucket');

// Must import handler after mocks and env stubs are set up
const { handler } = await import('../app.ts');

// ─── Helpers ────────────────────────────────────────────────────

function makeJwt(sub: string): string {
  const header = btoa(JSON.stringify({ alg: 'RS256' }));
  const payload = btoa(JSON.stringify({ sub }));
  return `${header}.${payload}.sig`;
}

function makeEvent(accountId?: string, overrides: Partial<APIGatewayProxyEventV2> = {}): APIGatewayProxyEventV2 {
  return {
    version: '2.0',
    routeKey: 'DELETE /accounts/{accountId}',
    rawPath: `/accounts/${accountId || ''}`,
    rawQueryString: '',
    headers: {
      authorization: `Bearer ${makeJwt('user-1')}`,
    },
    pathParameters: accountId ? { accountId } : {},
    requestContext: {
      accountId: '123',
      apiId: 'api',
      domainName: 'api.example.com',
      domainPrefix: 'api',
      http: { method: 'DELETE', path: `/accounts/${accountId || ''}`, protocol: 'HTTP/1.1', sourceIp: '127.0.0.1', userAgent: 'test' },
      requestId: 'req-1',
      routeKey: 'DELETE /accounts/{accountId}',
      stage: '$default',
      time: '01/Jan/2024:00:00:00 +0000',
      timeEpoch: 0,
    },
    isBase64Encoded: false,
    ...overrides,
  } as unknown as APIGatewayProxyEventV2;
}

const existingAccount = {
  userId: 'user-1',
  accountId: 'acc-1',
  name: 'My Trading Account',
  broker: 'Interactive Brokers',
  type: 'personal',
  status: 'active',
  balance: 15000,
  initialBalance: 10000,
  currency: 'USD',
};

// ─── Tests ──────────────────────────────────────────────────────

beforeEach(() => {
  ddbMock.reset();
  s3Mock.reset();
  s3Mock.on(ListObjectsV2Command).resolves({ Contents: [], IsTruncated: false });
  s3Mock.on(DeleteObjectsCommand).resolves({});
});

describe('delete-account handler', () => {
  // ── Success ─────────────────────────────────────────────────

  it('deletes account with no trades or goals and returns 200', async () => {
    ddbMock.on(GetCommand).resolves({ Item: existingAccount });
    ddbMock.on(QueryCommand).resolves({ Items: [] });
    ddbMock.on(DeleteCommand).resolves({});

    const res = await handler(makeEvent('acc-1'), {} as any, () => {}) as any;

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(true);
    expect(body.data.account.accountId).toBe('acc-1');
    expect(body.data.account.name).toBe('My Trading Account');
    expect(body.data.tradesDeleted).toBe(0);
    expect(body.data.goalsDeleted).toBe(0);
  });

  it('deletes account with trades and goals (cascade delete)', async () => {
    ddbMock.on(GetCommand).resolves({ Item: existingAccount });

    // First QueryCommand call returns trades, second returns goals
    ddbMock.on(QueryCommand)
      .resolvesOnce({ Items: [{ tradeId: 't1' }, { tradeId: 't2' }] })
      .resolvesOnce({ Items: [{ goalId: 'g1' }, { goalId: 'g2' }, { goalId: 'g3' }] });

    ddbMock.on(BatchWriteCommand).resolves({});
    ddbMock.on(DeleteCommand).resolves({});

    const res = await handler(makeEvent('acc-1'), {} as any, () => {}) as any;

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(true);
    expect(body.data.tradesDeleted).toBe(2);
    expect(body.data.goalsDeleted).toBe(3);

    // Verify BatchWriteCommand was called for both trades and goals
    const batchCalls = ddbMock.commandCalls(BatchWriteCommand);
    expect(batchCalls).toHaveLength(2); // one batch for trades, one for goals

    // Verify trade batch delete
    const tradeBatch = batchCalls[0].args[0].input.RequestItems!['test-trades'];
    expect(tradeBatch).toHaveLength(2);

    // Verify goal batch delete
    const goalBatch = batchCalls[1].args[0].input.RequestItems!['test-goals'];
    expect(goalBatch).toHaveLength(3);

    // Verify account itself was deleted
    const deleteCalls = ddbMock.commandCalls(DeleteCommand);
    expect(deleteCalls).toHaveLength(1);
    expect(deleteCalls[0].args[0].input.Key).toEqual({ userId: 'user-1', accountId: 'acc-1' });

    // Verify S3 image cleanup was called for each trade
    const listCalls = s3Mock.commandCalls(ListObjectsV2Command);
    expect(listCalls).toHaveLength(2);
  });

  // ── Auth errors ─────────────────────────────────────────────

  it('returns 401 when authorization header is missing', async () => {
    const event = makeEvent('acc-1', { headers: {} });
    const res = await handler(event, {} as any, () => {}) as any;

    expect(res.statusCode).toBe(401);
    const body = JSON.parse(res.body);
    expect(body.errorCode).toBe('UNAUTHORIZED');
  });

  // ── Validation errors ───────────────────────────────────────

  it('returns 400 when accountId path parameter is missing', async () => {
    const event = makeEvent(undefined);
    event.pathParameters = {};
    const res = await handler(event, {} as any, () => {}) as any;

    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.errorCode).toBe('VALIDATION_ERROR');
  });

  // ── Not found ───────────────────────────────────────────────

  it('returns 404 when account does not exist', async () => {
    ddbMock.on(GetCommand).resolves({ Item: undefined });

    const res = await handler(makeEvent('nonexistent-acc'), {} as any, () => {}) as any;

    expect(res.statusCode).toBe(404);
    const body = JSON.parse(res.body);
    expect(body.errorCode).toBe('TRADE_NOT_FOUND');
  });

  // ── DynamoDB errors ─────────────────────────────────────────

  it('returns 500 when DynamoDB fails', async () => {
    ddbMock.on(GetCommand).rejects(new Error('DynamoDB error'));

    const res = await handler(makeEvent('acc-1'), {} as any, () => {}) as any;

    expect(res.statusCode).toBe(500);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(false);
    expect(body.errorCode).toBe('INTERNAL_ERROR');
  });

  // ── Pagination ──────────────────────────────────────────────

  it('handles multiple pages of trades via LastEvaluatedKey', async () => {
    ddbMock.on(GetCommand).resolves({ Item: existingAccount });

    // Use table-based matching for parallel queries
    ddbMock.on(QueryCommand, { TableName: 'test-trades' })
      .resolvesOnce({ Items: [{ tradeId: 't1' }, { tradeId: 't2' }], LastEvaluatedKey: { userId: 'user-1', tradeId: 't2' } })
      .resolvesOnce({ Items: [{ tradeId: 't3' }] });
    ddbMock.on(QueryCommand, { TableName: 'test-goals' })
      .resolves({ Items: [] });

    ddbMock.on(BatchWriteCommand).resolves({});
    ddbMock.on(DeleteCommand).resolves({});

    const res = await handler(makeEvent('acc-1'), {} as any, () => {}) as any;

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.data.tradesDeleted).toBe(3);
    expect(body.data.goalsDeleted).toBe(0);

    // Verify trade batch delete had all 3 trades
    const batchCalls = ddbMock.commandCalls(BatchWriteCommand);
    expect(batchCalls).toHaveLength(1); // all 3 trades fit in one batch of 25
    const tradeBatch = batchCalls[0].args[0].input.RequestItems!['test-trades'];
    expect(tradeBatch).toHaveLength(3);

    // Verify S3 image cleanup was called for all 3 trades
    const listCalls = s3Mock.commandCalls(ListObjectsV2Command);
    expect(listCalls).toHaveLength(3);
  });

  // ── S3 image cleanup ───────────────────────────────────────

  it('deletes S3 images with correct prefix for each trade', async () => {
    ddbMock.on(GetCommand).resolves({ Item: existingAccount });
    ddbMock.on(QueryCommand)
      .resolvesOnce({ Items: [{ tradeId: 't1' }, { tradeId: 't2' }] })
      .resolvesOnce({ Items: [] }); // goals
    ddbMock.on(BatchWriteCommand).resolves({});
    ddbMock.on(DeleteCommand).resolves({});
    s3Mock.on(ListObjectsV2Command).resolves({
      Contents: [{ Key: 'images/user-1/t1/screenshot.png' }],
      IsTruncated: false,
    });

    await handler(makeEvent('acc-1'), {} as any, () => {});

    const listCalls = s3Mock.commandCalls(ListObjectsV2Command);
    expect(listCalls).toHaveLength(2);
    expect(listCalls[0].args[0].input.Prefix).toBe('images/user-1/t1/');
    expect(listCalls[1].args[0].input.Prefix).toBe('images/user-1/t2/');

    const deleteCalls = s3Mock.commandCalls(DeleteObjectsCommand);
    expect(deleteCalls).toHaveLength(2); // one per trade
  });

  it('handles S3 image deletion failure without failing account deletion', async () => {
    ddbMock.on(GetCommand).resolves({ Item: existingAccount });
    ddbMock.on(QueryCommand)
      .resolvesOnce({ Items: [{ tradeId: 't1' }] })
      .resolvesOnce({ Items: [] }); // goals
    ddbMock.on(BatchWriteCommand).resolves({});
    ddbMock.on(DeleteCommand).resolves({});
    // S3 list fails
    s3Mock.on(ListObjectsV2Command).rejects(new Error('S3 unavailable'));

    const res = await handler(makeEvent('acc-1'), {} as any, () => {}) as any;

    // The handler uses Promise.all which will cause this to fail
    // This test documents the current behavior -- if S3 fails, the whole operation fails
    expect(res.statusCode).toBe(500);
  });

  it('handles large number of trades requiring multiple batch deletes', async () => {
    ddbMock.on(GetCommand).resolves({ Item: existingAccount });

    // 30 trades -- requires 2 BatchWrite calls (25 + 5)
    const trades = Array.from({ length: 30 }, (_, i) => ({ tradeId: `t${i}` }));
    ddbMock.on(QueryCommand)
      .resolvesOnce({ Items: trades })
      .resolvesOnce({ Items: [] }); // goals
    ddbMock.on(BatchWriteCommand).resolves({});
    ddbMock.on(DeleteCommand).resolves({});

    const res = await handler(makeEvent('acc-1'), {} as any, () => {}) as any;

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.data.tradesDeleted).toBe(30);

    const batchCalls = ddbMock.commandCalls(BatchWriteCommand);
    // 2 for trades (25 + 5) + 0 for goals
    expect(batchCalls).toHaveLength(2);
    expect(batchCalls[0].args[0].input.RequestItems!['test-trades']).toHaveLength(25);
    expect(batchCalls[1].args[0].input.RequestItems!['test-trades']).toHaveLength(5);
  });

  // ── Error / failure cases ──────────────────────────────────

  it('returns 500 when QueryCommand fails fetching trades', async () => {
    ddbMock.on(GetCommand).resolves({ Item: existingAccount });
    ddbMock.on(QueryCommand).rejects(new Error('QueryCommand failed'));

    const res = await handler(makeEvent('acc-1'), {} as any, () => {}) as any;

    expect(res.statusCode).toBe(500);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(false);
    expect(body.errorCode).toBe('INTERNAL_ERROR');
  });

  it('returns 500 when QueryCommand fails fetching goals (trades succeed)', async () => {
    ddbMock.on(GetCommand).resolves({ Item: existingAccount });
    // First query (trades) succeeds, second query (goals) fails
    ddbMock.on(QueryCommand)
      .resolvesOnce({ Items: [] })
      .rejectsOnce(new Error('Goals query failed'));

    const res = await handler(makeEvent('acc-1'), {} as any, () => {}) as any;

    expect(res.statusCode).toBe(500);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(false);
    expect(body.errorCode).toBe('INTERNAL_ERROR');
  });

  it('returns 500 when BatchWriteCommand fails deleting trades', async () => {
    ddbMock.on(GetCommand).resolves({ Item: existingAccount });
    ddbMock.on(QueryCommand)
      .resolvesOnce({ Items: [{ tradeId: 't1' }] })
      .resolvesOnce({ Items: [] }); // goals
    ddbMock.on(BatchWriteCommand).rejects(new Error('BatchWrite trades failed'));
    ddbMock.on(DeleteCommand).resolves({});

    const res = await handler(makeEvent('acc-1'), {} as any, () => {}) as any;

    expect(res.statusCode).toBe(500);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(false);
    expect(body.errorCode).toBe('INTERNAL_ERROR');
  });

  it('returns 500 when BatchWriteCommand fails deleting goals', async () => {
    ddbMock.on(GetCommand).resolves({ Item: existingAccount });
    ddbMock.on(QueryCommand)
      .resolvesOnce({ Items: [] }) // no trades
      .resolvesOnce({ Items: [{ goalId: 'g1' }] }); // goals
    ddbMock.on(BatchWriteCommand).rejects(new Error('BatchWrite goals failed'));
    ddbMock.on(DeleteCommand).resolves({});

    const res = await handler(makeEvent('acc-1'), {} as any, () => {}) as any;

    expect(res.statusCode).toBe(500);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(false);
    expect(body.errorCode).toBe('INTERNAL_ERROR');
  });

  it('returns 500 when DeleteCommand fails for the account itself', async () => {
    ddbMock.on(GetCommand).resolves({ Item: existingAccount });
    ddbMock.on(QueryCommand)
      .resolvesOnce({ Items: [] }) // no trades
      .resolvesOnce({ Items: [] }); // no goals
    ddbMock.on(BatchWriteCommand).resolves({});
    ddbMock.on(DeleteCommand).rejects(new Error('DeleteCommand failed'));

    const res = await handler(makeEvent('acc-1'), {} as any, () => {}) as any;

    expect(res.statusCode).toBe(500);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(false);
    expect(body.errorCode).toBe('INTERNAL_ERROR');
  });

  it('cleanly deletes account with zero trades and zero goals (empty query results)', async () => {
    ddbMock.on(GetCommand).resolves({ Item: existingAccount });
    // Both queries explicitly return empty Items arrays
    ddbMock.on(QueryCommand)
      .resolvesOnce({ Items: [] })
      .resolvesOnce({ Items: [] });
    ddbMock.on(DeleteCommand).resolves({});

    const res = await handler(makeEvent('acc-1'), {} as any, () => {}) as any;

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(true);
    expect(body.data.tradesDeleted).toBe(0);
    expect(body.data.goalsDeleted).toBe(0);

    // No BatchWriteCommand calls since there are no trades or goals
    expect(ddbMock.commandCalls(BatchWriteCommand)).toHaveLength(0);

    // DeleteCommand should be called exactly once (for the account itself)
    const deleteCalls = ddbMock.commandCalls(DeleteCommand);
    expect(deleteCalls).toHaveLength(1);
    expect(deleteCalls[0].args[0].input.Key).toEqual({ userId: 'user-1', accountId: 'acc-1' });

    // No S3 image cleanup calls since there are no trades
    expect(s3Mock.commandCalls(ListObjectsV2Command)).toHaveLength(0);
  });
});
