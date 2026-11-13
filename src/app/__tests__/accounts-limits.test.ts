import { BatchGetCommand, DynamoDBDocumentClient, GetCommand, QueryCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { mockClient } from 'aws-sdk-client-mock';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.stubEnv('USER_POOL_ID', 'us-east-1_t');
vi.stubEnv('USER_POOL_CLIENT_ID', 'c');
vi.stubEnv('ALLOWED_ORIGINS', 'https://dev.tradequt.com');
vi.stubEnv('SUBSCRIPTIONS_TABLE', 'subs');
vi.stubEnv('ACCOUNTS_TABLE', 'accounts');
vi.stubEnv('TRADES_TABLE', 'trades');

// The legacy handlers are replaced so the guards are tested on their own.
const reached = vi.fn();
const stub = (...args: any[]) => {
  reached(...args);
  return { statusCode: 200, body: JSON.stringify({ success: true, ok: 1 }) };
};
vi.mock('../../handlers/create-account/app', () => ({ handler: stub }));
vi.mock('../../handlers/create-trade/app', () => ({ handler: stub }));
vi.mock('../../handlers/update-trade/app', () => ({ handler: stub }));
vi.mock('../../handlers/delete-trade/app', () => ({ handler: stub }));
vi.mock('../../handlers/bulk-delete-trades/app', () => ({ handler: stub }));
vi.mock('../../handlers/bulk-update-trades/app', () => ({ handler: stub }));
vi.mock('../../handlers/restore-trades/app', () => ({ handler: stub }));
vi.mock('../../handlers/update-account/app', () => ({ handler: stub }));
vi.mock('../../handlers/update-account-status/app', () => ({ handler: stub }));
vi.mock('../../handlers/delete-account/app', () => ({ handler: stub }));

const ddb = mockClient(DynamoDBDocumentClient);
const { createApp } = await import('../app');
const { setTokenVerifier } = await import('../auth/cognito');
const app = createApp();
const headers = { authorization: 'Bearer good', 'content-type': 'application/json' };
const send = (method: string, path: string, body?: unknown) =>
  app.request(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });

const day = 86400000;
let subscription: any;
let accounts: string[];

beforeEach(() => {
  ddb.reset();
  reached.mockReset();
  setTokenVerifier({ verify: async () => ({ sub: 'u1', email: 'u@x.y' }) });
  subscription = { userId: 'u1', status: 'cancelled', trialEnd: new Date(Date.now() - day).toISOString() };
  accounts = ['a1', 'a2', 'a3'];
  ddb.on(GetCommand).callsFake((input) =>
    input.TableName === 'subs' ? { Item: subscription } : { Item: { userId: 'u1', tradeId: input.Key.tradeId, accountId: 'a3' } },
  );
  ddb.on(QueryCommand).callsFake(() => ({ Items: accounts.map((accountId) => ({ accountId })) }));
  ddb.on(UpdateCommand).resolves({});
});

describe('POST /v1/accounts (free plan holds 2 accounts)', () => {
  it('402 PLAN_REQUIRED unlimited_accounts when the free user already has 2', async () => {
    accounts = ['a1', 'a2'];
    const res = await send('POST', '/v1/accounts', { name: 'x' });
    expect(res.status).toBe(402);
    expect(await res.json()).toMatchObject({ errorCode: 'PLAN_REQUIRED', error: { feature: 'unlimited_accounts', plan: 'free', requiredPlan: 'pro', limit: 2 } });
    expect(reached).not.toHaveBeenCalled();
  });

  it('allows the first two accounts and any number on trial/Pro', async () => {
    accounts = ['a1'];
    expect((await send('POST', '/v1/accounts', {})).status).toBe(200);
    subscription = { userId: 'u1', status: 'active' };
    accounts = ['a1', 'a2', 'a3', 'a4'];
    expect((await send('POST', '/v1/accounts', {})).status).toBe(200);
  });
});

describe('writes on a free plan with more than 2 accounts', () => {
  it('writes to an account that is not chosen → 402 with allowedAccountIds; chosen accounts still work', async () => {
    subscription.writableAccountIds = ['a1', 'a2'];
    const blocked = await send('POST', '/v1/trades', { symbol: 'X', accountIds: ['a3'] });
    expect(blocked.status).toBe(402);
    expect(await blocked.json()).toMatchObject({ errorCode: 'PLAN_REQUIRED', error: { feature: 'unlimited_accounts', limit: 2, allowedAccountIds: ['a1', 'a2'] } });
    expect((await send('POST', '/v1/trades', { symbol: 'X', accountIds: ['a1'] })).status).toBe(200);
  });

  it('until accounts are chosen every account write is blocked, unassigned trades are not', async () => {
    const blocked = await send('POST', '/v1/trades', { symbol: 'X', accountIds: ['a1'] });
    expect(blocked.status).toBe(402);
    expect((await blocked.json()).error.allowedAccountIds).toEqual([]);
    expect((await send('POST', '/v1/trades', { symbol: 'X' })).status).toBe(200);
    expect((await send('POST', '/v1/trades', { symbol: 'X', accountIds: ['-1'] })).status).toBe(200);
  });

  it('bulk create checks every item', async () => {
    subscription.writableAccountIds = ['a1'];
    const res = await send('POST', '/v1/trades', { items: [{ accountIds: ['a1'] }, { accountIds: ['a2'] }] });
    expect(res.status).toBe(402);
  });

  it('an update without accountIds is checked against the stored trade account', async () => {
    subscription.writableAccountIds = ['a1', 'a2'];
    const res = await send('PUT', '/v1/trades/t9', { tradeNotes: 'n' });
    expect(res.status).toBe(402);
    subscription.writableAccountIds = ['a1', 'a3'];
    expect((await send('PUT', '/v1/trades/t9', { tradeNotes: 'n' })).status).toBe(200);
  });

  it('the handler still receives the body after the guard read it', async () => {
    subscription.writableAccountIds = ['a1'];
    await send('POST', '/v1/trades', { symbol: 'X', accountIds: ['a1'] });
    expect(JSON.parse(reached.mock.calls[0][0].body)).toEqual({ symbol: 'X', accountIds: ['a1'] });
  });

  it('Pro users and users with at most 2 accounts are never restricted', async () => {
    subscription = { userId: 'u1', status: 'active' };
    expect((await send('POST', '/v1/trades', { accountIds: ['a3'] })).status).toBe(200);
    subscription = { userId: 'u1', status: 'cancelled' };
    accounts = ['a1', 'a2'];
    expect((await send('POST', '/v1/trades', { accountIds: ['a2'] })).status).toBe(200);
  });
});

describe('every write to a read-only account is blocked, not only create and update (BE-062)', () => {
  const storedAccount: Record<string, string> = { 'in-a1': 'a1', 'in-a3': 'a3' };

  beforeEach(() => {
    subscription.writableAccountIds = ['a1', 'a2'];
    ddb.on(BatchGetCommand).callsFake((input) => ({
      Responses: {
        trades: input.RequestItems.trades.Keys.filter((k: any) => storedAccount[k.tradeId]).map((k: any) => ({ accountId: storedAccount[k.tradeId] })),
      },
    }));
  });

  it('DELETE /v1/trades/{id} of a trade in a read-only account → 402; in a writable account → 200', async () => {
    ddb.on(GetCommand).callsFake((input) =>
      input.TableName === 'subs' ? { Item: subscription } : { Item: { tradeId: input.Key.tradeId, accountId: storedAccount[input.Key.tradeId] } },
    );
    expect((await send('DELETE', '/v1/trades/in-a3')).status).toBe(402);
    expect((await send('DELETE', '/v1/trades/in-a1')).status).toBe(200);
    expect(reached).toHaveBeenCalledTimes(1);
  });

  it.each([['/v1/trades/bulk-delete'], ['/v1/trades/restore']])('POST %s with a trade of a read-only account → 402 and the handler is not reached', async (path) => {
    const blocked = await send('POST', path, { tradeIds: ['in-a1', 'in-a3'] });
    expect(blocked.status).toBe(402);
    expect(await blocked.json()).toMatchObject({ errorCode: 'PLAN_REQUIRED', error: { feature: 'unlimited_accounts', allowedAccountIds: ['a1', 'a2'] } });
    expect(reached).not.toHaveBeenCalled();
    expect((await send('POST', path, { tradeIds: ['in-a1'] })).status).toBe(200);
  });

  it('PUT /v1/accounts/{id} and PATCH /v1/accounts/{id}/status change only writable accounts', async () => {
    expect((await send('PUT', '/v1/accounts/a3', { name: 'x' })).status).toBe(402);
    expect((await send('PATCH', '/v1/accounts/a3/status', { status: 'inactive' })).status).toBe(402);
    expect((await send('PUT', '/v1/accounts/a1', { name: 'x' })).status).toBe(200);
    expect((await send('PATCH', '/v1/accounts/a2/status', { status: 'inactive' })).status).toBe(200);
  });

  it('deleting an account stays open: it is the way back under the limit', async () => {
    expect((await send('DELETE', '/v1/accounts/a3')).status).toBe(200);
  });

  it('Pro users are never restricted', async () => {
    subscription = { userId: 'u1', status: 'active' };
    expect((await send('POST', '/v1/trades/bulk-delete', { tradeIds: ['in-a3'] })).status).toBe(200);
    expect((await send('PUT', '/v1/accounts/a3', {})).status).toBe(200);
  });
});

describe('bulk update with throttled BatchGet (BE-061)', () => {
  beforeEach(() => {
    subscription.writableAccountIds = ['a1', 'a2'];
  });

  it('retries unprocessed keys, so a trade of a read-only account is still caught', async () => {
    ddb
      .on(BatchGetCommand)
      .resolvesOnce({ Responses: { trades: [{ accountId: 'a1' }] }, UnprocessedKeys: { trades: { Keys: [{ userId: 'u1', tradeId: 't2' }] } } })
      .resolves({ Responses: { trades: [{ accountId: 'a3' }] } });

    const res = await send('POST', '/v1/trades/bulk-update', { tradeIds: ['t1', 't2'], set: { tradeNotes: 'n' } });

    expect(res.status).toBe(402);
    expect(ddb.commandCalls(BatchGetCommand)).toHaveLength(2);
    expect(reached).not.toHaveBeenCalled();
  });

  it('fails closed (no update) when keys stay unprocessed', async () => {
    ddb.on(BatchGetCommand).resolves({ Responses: { trades: [] }, UnprocessedKeys: { trades: { Keys: [{ userId: 'u1', tradeId: 't2' }] } } });

    const res = await send('POST', '/v1/trades/bulk-update', { tradeIds: ['t1', 't2'], set: { tradeNotes: 'n' } });

    expect(res.status).toBeGreaterThanOrEqual(500);
    expect(reached).not.toHaveBeenCalled();
  });

  it('does not send duplicate keys and leaves oversized lists to the handler', async () => {
    ddb.on(BatchGetCommand).resolves({ Responses: { trades: [{ accountId: 'a1' }] } });
    await send('POST', '/v1/trades/bulk-update', { tradeIds: ['t1', 't1'], set: { tradeNotes: 'n' } });
    expect(ddb.commandCalls(BatchGetCommand)[0].args[0].input.RequestItems!.trades.Keys).toHaveLength(1);

    ddb.resetHistory();
    await send('POST', '/v1/trades/bulk-update', { tradeIds: Array.from({ length: 201 }, (_, i) => `t${i}`) });
    expect(ddb.commandCalls(BatchGetCommand)).toHaveLength(0);
  });
});

describe('PUT /v1/me/writable-accounts', () => {
  it('stores at most 2 owned accounts', async () => {
    const res = await send('PUT', '/v1/me/writable-accounts', { accountIds: ['a1', 'a3'] });
    expect(res.status).toBe(200);
    expect(ddb.commandCalls(UpdateCommand)[0].args[0].input.ExpressionAttributeValues![':ids']).toEqual(['a1', 'a3']);
  });

  it('rejects 3 accounts (402), unknown accounts and malformed input (400)', async () => {
    expect((await send('PUT', '/v1/me/writable-accounts', { accountIds: ['a1', 'a2', 'a3'] })).status).toBe(402);
    expect((await send('PUT', '/v1/me/writable-accounts', { accountIds: ['zzz'] })).status).toBe(400);
    expect((await send('PUT', '/v1/me/writable-accounts', { accountIds: 'a1' })).status).toBe(400);
    expect((await send('PUT', '/v1/me/writable-accounts', { accountIds: ['a1', 'a1'] })).status).toBe(400);
  });
});
