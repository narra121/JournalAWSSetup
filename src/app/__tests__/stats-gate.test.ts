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
  const readOnly = { userId: 'u1', status: 'cancelled', trialEnd: new Date(Date.now() - 86400000).toISOString(), plansVersion: 2 };

  it('a read-only user (trial over) still reads the advanced section: every read works after the trial', async () => {
    ddb.on(GetCommand).resolves({ Item: readOnly });
    expect((await get('accountId=ALL&sections=advanced')).status).toBe(200);
    expect((await get('accountId=ALL')).status).toBe(200);
    expect(reached).toHaveBeenCalledTimes(2);
  });

  it('the gate decides on the same string the handler receives', async () => {
    ddb.on(GetCommand).resolves({ Item: { userId: 'u1', status: 'active', plansVersion: 2 } });
    await get('accountId=ALL&sections=x&sections=advanced');
    const received = reached.mock.calls[0][0].queryStringParameters.sections;
    expect(received).toBe('x,advanced');
    expect(wantsAdvancedSection(received)).toBe(true);
  });

  it('trial and Pro users get the section', async () => {
    ddb.on(GetCommand).resolves({ Item: { userId: 'u1', status: 'active', plansVersion: 2 } });
    expect((await get('accountId=ALL&sections=advanced')).status).toBe(200);
    expect(reached).toHaveBeenCalledTimes(1);
  });
});
