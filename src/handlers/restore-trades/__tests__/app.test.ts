import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DynamoDBDocumentClient, GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { mockClient } from 'aws-sdk-client-mock';

vi.stubEnv('TRADES_TABLE', 'trades');
const ddb = mockClient(DynamoDBDocumentClient);
const { handler } = await import('../app.ts');

const event = (body: any, claims: any = { sub: 'u1' }) =>
  ({ requestContext: { requestId: 'r', authorizer: { jwt: { claims } } }, body: typeof body === 'string' ? body : JSON.stringify(body) }) as any;
const call = async (e: any) => (await handler(e, {} as any, () => {})) as any;

beforeEach(() => {
  ddb.reset();
  ddb.on(GetCommand).callsFake((i) =>
    i.Key.tradeId === 'live' ? { Item: { userId: 'u1', tradeId: 'live' } }
      : i.Key.tradeId === 'gone' ? {}
        : { Item: { userId: 'u1', tradeId: i.Key.tradeId, deletedAt: '2026-11-01T00:00:00Z', ttl: 1, deletedIdempotencyKey: i.Key.tradeId === 'imp' ? 'k-1' : undefined } });
  ddb.on(UpdateCommand).resolves({});
});

describe('restore-trades', () => {
  it('restores soft-deleted trades and reports ones that are live or missing', async () => {
    const res = await call(event({ tradeIds: ['t1', 'live', 'gone'] }));
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).data).toEqual({ restored: ['t1'], notFound: ['live', 'gone'], errors: [] });
  });

  it('clears deletedAt and the TTL, and puts the idempotency key back', async () => {
    await call(event({ tradeIds: ['imp'] }));
    const input = ddb.commandCalls(UpdateCommand)[0].args[0].input;
    expect(input.UpdateExpression).toBe('SET #updatedAt = :now, #idem = :idem REMOVE #deletedAt, #ttl, #delIdem');
    expect(input.ExpressionAttributeValues![':idem']).toBe('k-1');
    expect(input.Key).toEqual({ userId: 'u1', tradeId: 'imp' });
  });

  it('400 for bad input or more than 200 ids; 401 without claims', async () => {
    expect((await call(event({ tradeIds: [] }))).statusCode).toBe(400);
    expect((await call(event('{oops'))).statusCode).toBe(400);
    expect((await call(event({ tradeIds: Array.from({ length: 201 }, (_, i) => `t${i}`) }))).statusCode).toBe(400);
    expect((await call(event({ tradeIds: ['t1'] }, {}))).statusCode).toBe(401);
  });
});
