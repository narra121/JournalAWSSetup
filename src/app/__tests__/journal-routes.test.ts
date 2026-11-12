import { DeleteCommand, DynamoDBDocumentClient, GetCommand, PutCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { mockClient } from 'aws-sdk-client-mock';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.stubEnv('USER_POOL_ID', 'us-east-1_t');
vi.stubEnv('USER_POOL_CLIENT_ID', 'c');
vi.stubEnv('ALLOWED_ORIGINS', 'https://dev.tradequt.com');
vi.stubEnv('AI_DATA_TABLE', 'ai');

const ddb = mockClient(DynamoDBDocumentClient);
const { createApp } = await import('../app');
const { setTokenVerifier } = await import('../auth/cognito');
const app = createApp();
const headers = { authorization: 'Bearer good', 'content-type': 'application/json' };
const put = (date: string, body: unknown) => app.request(`/v1/journal/days/${date}`, { method: 'PUT', headers, body: typeof body === 'string' ? body : JSON.stringify(body) });

beforeEach(() => {
  ddb.reset();
  setTokenVerifier({ verify: async () => ({ sub: 'u1' }) });
  ddb.on(PutCommand).resolves({});
  ddb.on(DeleteCommand).resolves({});
  ddb.on(GetCommand).resolves({});
});

describe('PUT /v1/journal/days/{date}', () => {
  it('stores a note per day and account scope in the AiData table', async () => {
    const res = await put('2026-11-11', { accountId: 'acc-1', plan: ' trade the range ', review: 'ok' });
    expect(res.status).toBe(200);
    expect((await res.json()).data).toMatchObject({ date: '2026-11-11', accountId: 'acc-1', plan: 'trade the range', review: 'ok' });
    const item = ddb.commandCalls(PutCommand)[0].args[0].input.Item!;
    expect(item).toMatchObject({ userId: 'u1', sk: 'DAYNOTE#2026-11-11#acc-1', plan: 'trade the range', review: 'ok' });
  });

  it('no accountId means the all-accounts scope (null in the response)', async () => {
    const res = await put('2026-11-11', { plan: 'p', review: 'r' });
    expect((await res.json()).data.accountId).toBeNull();
    expect(ddb.commandCalls(PutCommand)[0].args[0].input.Item!.sk).toBe('DAYNOTE#2026-11-11#ALL');
  });

  it('a field left out keeps its stored text (autosave of one box does not wipe the other)', async () => {
    ddb.on(GetCommand).resolves({ Item: { plan: 'old plan', review: 'old review' } });
    await put('2026-11-11', { review: 'new review' });
    expect(ddb.commandCalls(PutCommand)[0].args[0].input.Item).toMatchObject({ plan: 'old plan', review: 'new review' });
  });

  it('clearing both texts removes the note', async () => {
    ddb.on(GetCommand).resolves({ Item: { plan: 'p', review: '' } });
    await put('2026-11-11', { plan: '' });
    expect(ddb.commandCalls(DeleteCommand)).toHaveLength(1);
    expect(ddb.commandCalls(PutCommand)).toHaveLength(0);
  });

  it('accepts exactly 2,000 characters and rejects 2,001, bad dates and bad bodies', async () => {
    expect((await put('2026-11-11', { plan: 'x'.repeat(2000) })).status).toBe(200);
    expect((await put('2026-11-11', { plan: 'x'.repeat(2001) })).status).toBe(400);
    expect((await put('11-11-2026', { plan: 'x' })).status).toBe(400);
    expect((await put('2026-13-45', { plan: 'x' })).status).toBe(400);
    expect((await put('2026-11-11', 'null')).status).toBe(400);
    expect((await put('2026-11-11', { plan: 5 })).status).toBe(400);
  });

  it('requires authentication', async () => {
    setTokenVerifier({ verify: async () => Promise.reject(new Error('bad')) });
    expect((await put('2026-11-11', { plan: 'x' })).status).toBe(401);
  });
});

describe('GET /v1/journal/days', () => {
  const items = [
    { date: '2026-11-10', scope: 'ALL', plan: 'a', review: '', updatedAt: 't1' },
    { date: '2026-11-11', scope: 'acc-1', plan: 'b', review: 'c', updatedAt: 't2' },
  ];

  it('lists notes in the range with the DAYNOTE key range', async () => {
    ddb.on(QueryCommand).resolves({ Items: items });
    const res = await app.request('/v1/journal/days?from=2026-11-01&to=2026-11-30', { headers });
    expect((await res.json()).data.days).toEqual([
      { date: '2026-11-10', accountId: null, plan: 'a', review: '', updatedAt: 't1' },
      { date: '2026-11-11', accountId: 'acc-1', plan: 'b', review: 'c', updatedAt: 't2' },
    ]);
    expect(ddb.commandCalls(QueryCommand)[0].args[0].input.ExpressionAttributeValues).toMatchObject({ ':u': 'u1', ':a': 'DAYNOTE#2026-11-01', ':b': 'DAYNOTE#2026-11-30#~' });
  });

  it('filters by account scope (ALL = the null scope) and validates the range', async () => {
    ddb.on(QueryCommand).resolves({ Items: items });
    const one = await app.request('/v1/journal/days?accountId=acc-1', { headers });
    expect((await one.json()).data.days.map((d: any) => d.date)).toEqual(['2026-11-11']);
    const all = await app.request('/v1/journal/days?accountId=ALL', { headers });
    expect((await all.json()).data.days.map((d: any) => d.date)).toEqual(['2026-11-10']);
    expect((await app.request('/v1/journal/days?from=bad', { headers })).status).toBe(400);
  });
});
