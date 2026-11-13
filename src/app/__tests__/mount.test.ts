import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBDocumentClient, GetCommand, QueryCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppEnv } from '../types';

vi.stubEnv('USER_POOL_ID', 'us-east-1_test');
vi.stubEnv('USER_POOL_CLIENT_ID', 'client');
vi.stubEnv('ALLOWED_ORIGINS', 'https://dev.tradequt.com');
vi.stubEnv('SUBSCRIPTIONS_TABLE', 'subs');
vi.stubEnv('USAGE_TABLE', 'usage');

const { createApp } = await import('../app');
const { setTokenVerifier } = await import('../auth/cognito');
const ddb = mockClient(DynamoDBDocumentClient);

const feature = new Hono<AppEnv>();
feature.get('/whoami', (c) => c.json({ userId: c.get('userId'), plan: c.get('entitlements').plan }));
feature.post('/spend', async (c) => {
  const r = await c.get('quota').consume('ai_chat');
  return r.ok ? c.json({ remaining: r.remaining }) : c.json({ denied: true }, 402);
});

const app = createApp({ featureRoutes: [{ basePath: '/stub', app: feature }] });
const auth = { authorization: 'Bearer good' };

beforeEach(() => {
  ddb.reset();
  setTokenVerifier({ verify: async (t) => (t === 'good' ? { sub: 'u1', email: 'u@x.y' } : Promise.reject(new Error('bad'))) });
});
afterEach(() => setTokenVerifier(undefined));

describe('feature route mounting', () => {
  it('rejects unauthenticated calls with 401 before the feature runs', async () => {
    const res = await app.request('/v1/stub/whoami');
    expect(res.status).toBe(401);
  });

  it('exposes userId and entitlements (free without a subscription item)', async () => {
    ddb.on(GetCommand).resolves({});
    const res = await app.request('/v1/stub/whoami', { headers: auth });
    expect(await res.json()).toEqual({ userId: 'u1', plan: 'free' });
  });

  it('a trial in the future gives the trial plan', async () => {
    ddb.on(GetCommand).resolves({ Item: { userId: 'u1', status: 'trial', trialEnd: new Date(Date.now() + 86400000).toISOString() } });
    const res = await app.request('/v1/stub/whoami', { headers: auth });
    expect((await res.json()).plan).toBe('trial');
  });

  it('quota.consume spends against the limit with a conditional update', async () => {
    ddb.on(GetCommand).resolves({});
    ddb.on(UpdateCommand).resolves({ Attributes: { count: 4 } });
    const res = await app.request('/v1/stub/spend', { method: 'POST', headers: auth });
    expect(await res.json()).toEqual({ remaining: 6 });
    const input = ddb.commandCalls(UpdateCommand)[0].args[0].input;
    expect(input.ConditionExpression).toContain('attribute_not_exists');
    expect(input.ExpressionAttributeValues).toMatchObject({ ':n': 1, ':max': 9 });
  });
});

describe('GET /v1/me/entitlements', () => {
  it('returns entitlements, usage, reset date and billing currency', async () => {
    ddb.on(GetCommand).resolves({ Item: { userId: 'u1', status: 'active', writableAccountIds: ['a1'] } });
    ddb.on(QueryCommand).resolves({ Items: [{ sk: `${new Date().toISOString().slice(0, 7)}#ai_chat`, count: 3 }] });
    const res = await app.request('/v1/me/entitlements', { headers: { ...auth, 'cloudfront-viewer-country': 'IN' } });
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.data.entitlements).toMatchObject({ plan: 'pro', limits: { ai_extract: 200, ai_insight: 30, ai_chat: 500, broker_import: 200, ai_enhance: 500 } });
    expect(body.data.usage).toEqual({ ai_extract: 0, ai_insight: 0, ai_chat: 3, broker_import: 0, ai_enhance: 0 });
    expect(body.data.billingCurrency).toBe('INR');
    expect(body.data.writableAccountIds).toEqual(['a1']);
    expect(body.data.periodResetsAt).toMatch(/-01T00:00:00.000Z$/);
  });
});
