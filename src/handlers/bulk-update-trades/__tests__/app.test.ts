import { BatchGetCommand, DynamoDBDocumentClient, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { mockClient } from 'aws-sdk-client-mock';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.stubEnv('TRADES_TABLE', 'trades');
const { handler } = await import('../app.ts');
const ddb = mockClient(DynamoDBDocumentClient);

const event = (body: any, claims: any = { sub: 'u1' }) =>
  ({ requestContext: { requestId: 'r', authorizer: { jwt: { claims } } }, body: typeof body === 'string' ? body : JSON.stringify(body) }) as any;
const call = async (e: any) => (await handler(e, {} as any, () => {})) as any;
const input = (i: number) => ddb.commandCalls(UpdateCommand)[i].args[0].input;
const written = (i: number) => {
  const names = input(i).ExpressionAttributeNames as Record<string, string>;
  const values = input(i).ExpressionAttributeValues as Record<string, any>;
  return Object.fromEntries(Object.entries(names).filter(([n]) => n.startsWith('#f')).map(([n, f]) => [f, values[`:v${n.slice(2)}`]]));
};

const stored = [
  { userId: 'u1', tradeId: 't1', mistakes: ['fomo'], tags: ['a'], accountId: 'acc-1' },
  { userId: 'u1', tradeId: 't2', mistakes: [], accountId: 'acc-1' },
];

beforeEach(() => {
  ddb.reset();
  ddb.on(BatchGetCommand).resolves({ Responses: { trades: stored } });
  ddb.on(UpdateCommand).resolves({});
});

describe('bulk-update-trades', () => {
  it('sets scalar fields, adds and removes list entries per trade, and never touches other fields', async () => {
    const res = await call(event({ tradeIds: ['t1', 't2'], set: { setupType: 'Breakout' }, add: { mistakes: ['revenge', 'fomo'] }, remove: { tags: ['a'] } }));
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).data).toMatchObject({ updated: 2, notFound: [], failed: [] });
    const byTrade = Object.fromEntries([0, 1].map((i) => [input(i).Key!.tradeId, written(i)]));
    expect(byTrade.t1).toEqual({ setupType: 'Breakout', mistakes: ['fomo', 'revenge'], tags: [] });
    expect(byTrade.t2).toEqual({ setupType: 'Breakout', mistakes: ['revenge', 'fomo'], tags: [] });
    expect(Object.keys(byTrade.t1)).not.toContain('accountId');
  });

  it('every update is scoped to the caller and conditional on the trade existing', async () => {
    await call(event({ tradeIds: ['t1'], set: { tradeNotes: 'x' } }));
    expect(input(0)).toMatchObject({ Key: { userId: 'u1', tradeId: 't1' }, ConditionExpression: 'attribute_exists(tradeId)' });
    expect(ddb.commandCalls(BatchGetCommand)[0].args[0].input.RequestItems!.trades.Keys).toEqual([{ userId: 'u1', tradeId: 't1' }]);
  });

  it('reports ids that do not exist (or belong to someone else) and carries on', async () => {
    const res = await call(event({ tradeIds: ['t1', 'ghost'], set: { outcome: 'TP' } }));
    expect(JSON.parse(res.body).data).toMatchObject({ updated: 1, notFound: ['ghost'] });
  });

  it('reports per-trade failures without failing the batch', async () => {
    ddb.on(UpdateCommand).callsFake((i) => (i.Key.tradeId === 't1' ? Promise.reject(new Error('throttled')) : {}));
    const data = JSON.parse((await call(event({ tradeIds: ['t1', 't2'], set: { outcome: 'TP' } }))).body).data;
    expect(data.updated).toBe(1);
    expect(data.failed).toEqual([{ tradeId: 't1', message: 'throttled' }]);
  });

  it.each([
    ['more than 200 ids', { tradeIds: Array.from({ length: 201 }, (_, i) => `t${i}`), set: { outcome: 'TP' } }],
    ['no ids', { tradeIds: [], set: { outcome: 'TP' } }],
    ['duplicate ids', { tradeIds: ['t1', 't1'], set: { outcome: 'TP' } }],
    ['nothing to change', { tradeIds: ['t1'] }],
    ['a field outside the allow-list', { tradeIds: ['t1'], set: { pnl: 1 } }],
    ['a list field in set', { tradeIds: ['t1'], set: { mistakes: ['x'] } }],
    ['non-string list entries', { tradeIds: ['t1'], add: { tags: [1] } }],
    ['a non-string scalar', { tradeIds: ['t1'], set: { setupType: 5 } }],
  ])('400 for %s', async (_n, body) => {
    expect((await call(event(body))).statusCode).toBe(400);
    expect(ddb.commandCalls(UpdateCommand)).toHaveLength(0);
  });

  it('accepts exactly 200 ids; 401 without claims; 400 for bad JSON', async () => {
    ddb.on(BatchGetCommand).resolves({ Responses: { trades: [] } });
    expect((await call(event({ tradeIds: Array.from({ length: 200 }, (_, i) => `t${i}`), set: { outcome: 'TP' } }))).statusCode).toBe(200);
    expect((await call(event({ tradeIds: ['t1'], set: { outcome: 'TP' } }, {}))).statusCode).toBe(401);
    expect((await call(event('{oops'))).statusCode).toBe(400);
  });
});
