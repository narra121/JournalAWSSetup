import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBDocumentClient, GetCommand, UpdateCommand, BatchWriteCommand } from '@aws-sdk/lib-dynamodb';
import type { APIGatewayProxyEventV2 } from 'aws-lambda';

vi.stubEnv('TRADES_TABLE', 'test-trades');
vi.mock('../../../shared/subscription', () => ({
  checkSubscription: vi.fn().mockResolvedValue(null),
}));

const ddbMock = mockClient(DynamoDBDocumentClient);
const { handler } = await import('../app.ts');

const jwt = `${btoa(JSON.stringify({ alg: 'RS256' }))}.${btoa(JSON.stringify({ sub: 'user-1' }))}.sig`;

function makeEvent(body?: any, headers: Record<string, string> = { authorization: `Bearer ${jwt}` }): APIGatewayProxyEventV2 {
  return {
    version: '2.0',
    routeKey: 'POST /trades/bulk-delete',
    rawPath: '/trades/bulk-delete',
    rawQueryString: '',
    headers,
    requestContext: { requestId: 'req-1', http: { method: 'POST' } },
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
    isBase64Encoded: false,
  } as unknown as APIGatewayProxyEventV2;
}

const call = async (e: APIGatewayProxyEventV2) => (await handler(e, {} as any, () => {})) as any;

beforeEach(() => {
  ddbMock.reset();
  ddbMock.on(GetCommand).callsFake((input) => (input.Key.tradeId.startsWith('ghost') ? {} : { Item: { userId: 'user-1', tradeId: input.Key.tradeId } }));
  ddbMock.on(UpdateCommand).resolves({});
});

describe('bulk-delete-trades handler (soft delete)', () => {
  it('soft-deletes every listed trade and reports unknown ids without failing', async () => {
    const res = await call(makeEvent({ tradeIds: ['t1', 't2', 'ghost-1'] }));
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).data).toMatchObject({ deletedRequested: 3, notFound: ['ghost-1'], errors: [] });
    expect(JSON.parse(res.body).data.deleted.sort()).toEqual(['t1', 't2']);
    expect(ddbMock.commandCalls(UpdateCommand)).toHaveLength(2);
    expect(ddbMock.commandCalls(BatchWriteCommand)).toHaveLength(0);
  });

  it('de-duplicates ids and accepts exactly 200, rejects 201', async () => {
    const dup = await call(makeEvent({ tradeIds: ['t1', 't1'] }));
    expect(JSON.parse(dup.body).data.deletedRequested).toBe(1);
    expect((await call(makeEvent({ tradeIds: Array.from({ length: 200 }, (_, i) => `t${i}`) }))).statusCode).toBe(200);
    expect((await call(makeEvent({ tradeIds: Array.from({ length: 201 }, (_, i) => `t${i}`) }))).statusCode).toBe(400);
  });

  it('reports a per-trade failure and carries on', async () => {
    ddbMock.on(UpdateCommand).callsFake((input) => (input.Key.tradeId === 't1' ? Promise.reject(new Error('throttled')) : {}));
    const data = JSON.parse((await call(makeEvent({ tradeIds: ['t1', 't2'] }))).body).data;
    expect(data.deleted).toEqual(['t2']);
    expect(data.errors).toEqual([{ tradeId: 't1', message: 'throttled' }]);
  });

  it('400 for bad input, 401 without claims', async () => {
    expect((await call(makeEvent())).statusCode).toBe(400);
    expect((await call(makeEvent('{oops'))).statusCode).toBe(400);
    expect((await call(makeEvent({ tradeIds: [] }))).statusCode).toBe(400);
    expect((await call(makeEvent({ tradeIds: [1] }))).statusCode).toBe(400);
    expect((await call(makeEvent({ tradeIds: ['t1'] }, {}))).statusCode).toBe(401);
  });
});
