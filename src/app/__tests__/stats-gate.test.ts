import { DynamoDBDocumentClient, GetCommand } from '@aws-sdk/lib-dynamodb';
import { mockClient } from 'aws-sdk-client-mock';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.stubEnv('USER_POOL_ID', 'us-east-1_t');
vi.stubEnv('USER_POOL_CLIENT_ID', 'c');
vi.stubEnv('ALLOWED_ORIGINS', 'https://dev.tradequt.com');
vi.stubEnv('SUBSCRIPTIONS_TABLE', 'subs');

const reached = vi.fn();
vi.mock('../../handlers/get-stats/app', () => ({ handler: (e: any) => (reached(e), { statusCode: 200, body: '{"success":true}' }) }));

const ddb = mockClient(DynamoDBDocumentClient);
const { createApp } = await import('../app');
const { setTokenVerifier } = await import('../auth/cognito');
const { wantsAdvancedSection } = await import('../../shared/statsSections');
const app = createApp();
const get = (qs: string) => app.request(`/v1/stats?${qs}`, { headers: { authorization: 'Bearer good' } });

beforeEach(() => {
  ddb.reset();
  reached.mockReset();
  setTokenVerifier({ verify: async () => ({ sub: 'u1' }) });
});

describe('GET /v1/stats?sections=advanced (advanced_analytics gate)', () => {
  it('Free plan → 402 PLAN_REQUIRED advanced_analytics; the default response is unchanged and needs no plan lookup', async () => {
    ddb.on(GetCommand).resolves({ Item: { userId: 'u1', status: 'cancelled' } });
    const blocked = await get('accountId=ALL&sections=advanced');
    expect(blocked.status).toBe(402);
    expect(await blocked.json()).toMatchObject({ errorCode: 'PLAN_REQUIRED', error: { feature: 'advanced_analytics', plan: 'free' } });
    expect(reached).not.toHaveBeenCalled();
    ddb.resetHistory();
    expect((await get('accountId=ALL')).status).toBe(200);
    expect(ddb.commandCalls(GetCommand)).toHaveLength(0);
  });

  it.each([
    ['repeated key, advanced last', 'accountId=ALL&sections=x&sections=advanced'],
    ['repeated key, advanced first', 'accountId=ALL&sections=advanced&sections=x'],
    ['comma list', 'accountId=ALL&sections=x,advanced'],
  ])('Free plan cannot get advanced by editing the query: %s (BE-002)', async (_name, qs) => {
    ddb.on(GetCommand).resolves({ Item: { userId: 'u1', status: 'cancelled' } });
    expect((await get(qs)).status).toBe(402);
    expect(reached).not.toHaveBeenCalled();
  });

  it('the gate decides on the same string the handler receives', async () => {
    ddb.on(GetCommand).resolves({ Item: { userId: 'u1', status: 'active' } });
    await get('accountId=ALL&sections=x&sections=advanced');
    const received = reached.mock.calls[0][0].queryStringParameters.sections;
    expect(received).toBe('x,advanced');
    expect(wantsAdvancedSection(received)).toBe(true);
  });

  it('trial and Pro users get the section', async () => {
    ddb.on(GetCommand).resolves({ Item: { userId: 'u1', status: 'active' } });
    expect((await get('accountId=ALL&sections=advanced')).status).toBe(200);
    expect(reached).toHaveBeenCalledTimes(1);
  });
});
