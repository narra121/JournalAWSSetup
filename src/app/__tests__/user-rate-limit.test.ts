import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBDocumentClient, GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppEnv } from '../types';

vi.stubEnv('USER_POOL_ID', 'us-east-1_test');
vi.stubEnv('USER_POOL_CLIENT_ID', 'client');
vi.stubEnv('ALLOWED_ORIGINS', 'https://dev.tradequt.com');
vi.stubEnv('RATE_LIMIT_TABLE', 'test-rate');
vi.stubEnv('SUBSCRIPTIONS_TABLE', 'subs');
vi.stubEnv('USAGE_TABLE', 'usage');
vi.stubEnv('IMAGES_BUCKET', 'images-bucket');

const { createApp } = await import('../app');
const { setTokenVerifier } = await import('../auth/cognito');
const { userRateLimit, USER_REQUESTS_PER_WINDOW, USER_WINDOW_SECONDS } = await import('../http/rate-limit');
const { defaultsFor } = await import('../../shared/apiError');
const ddb = mockClient(DynamoDBDocumentClient);

let featureRan = false;
const feature = new Hono<AppEnv>();
feature.get('/whoami', (c) => {
  featureRan = true;
  return c.json({ userId: c.get('userId') });
});

const app = createApp({ featureRoutes: [{ basePath: '/stub', app: feature }] });
const as = (sub: string) => ({ authorization: `Bearer ${sub}` });
const counted = (count: number, secondsLeft = 30) => ({ Attributes: { count, ttl: Math.floor(Date.now() / 1000) + secondsLeft } });

beforeEach(() => {
  ddb.reset();
  featureRan = false;
  setTokenVerifier({ verify: async (t) => (t === 'bad' ? Promise.reject(new Error('bad')) : { sub: t, email: `${t}@x.y` }) });
});
afterEach(() => setTokenVerifier(undefined));

describe('per-user request ceiling (BE-013)', () => {
  it('counts every signed-in request under user:<sub> with the fixed window, and lets a user at the limit through', async () => {
    ddb.on(GetCommand).resolves({});
    ddb.on(UpdateCommand).resolves(counted(USER_REQUESTS_PER_WINDOW));
    const res = await app.request('/v1/stub/whoami', { headers: as('u1') });
    expect(res.status).toBe(200);
    expect(featureRan).toBe(true);

    const input = ddb.commandCalls(UpdateCommand)[0].args[0].input;
    expect(input).toMatchObject({ TableName: 'test-rate', Key: { key: 'user:u1' } });
    expect(input.ExpressionAttributeValues![':newTtl']).toBeGreaterThan(Math.floor(Date.now() / 1000) + USER_WINDOW_SECONDS - 5);
  });

  it('keeps one bucket per user', async () => {
    ddb.on(GetCommand).resolves({});
    ddb.on(UpdateCommand).resolves(counted(1));
    await app.request('/v1/stub/whoami', { headers: as('u1') });
    await app.request('/v1/stub/whoami', { headers: as('u2') });
    expect(ddb.commandCalls(UpdateCommand).map((c) => c.args[0].input.Key!.key)).toEqual(['user:u1', 'user:u2']);
  });

  it.each([
    ['legacy handler route', 'GET', '/v1/trades'],
    ['account route', 'GET', '/v1/auth/export'],
    ['goals history', 'GET', '/v1/goals/history'],
    ['uploads', 'POST', '/v1/uploads/images'],
    ['journal', 'GET', '/v1/journal/days'],
    ['me', 'GET', '/v1/me/entitlements'],
    ['billing', 'POST', '/v1/billing/portal'],
    ['feature route', 'GET', '/v1/stub/whoami'],
  ])('the request over the limit gets 429 RATE_LIMITED in the shared envelope on a %s', async (_name, method, path) => {
    ddb.on(GetCommand).resolves({});
    ddb.on(UpdateCommand).resolves(counted(USER_REQUESTS_PER_WINDOW + 1));
    const res = await app.request(path, { method, headers: as('u1') });

    expect(res.status).toBe(429);
    const body = await res.json();
    expect(body).toMatchObject({
      success: false,
      errorCode: 'RATE_LIMITED',
      message: defaultsFor(429).message,
      errorMessage: defaultsFor(429).message,
      error: { code: 'RATE_LIMITED' },
    });
    expect(body.error.retryAfter).toBeGreaterThan(0);
    expect(body.error.retryAfter).toBeLessThanOrEqual(30);
    expect(res.headers.get('retry-after')).toBe(String(body.error.retryAfter));
    expect(featureRan).toBe(false);
    expect(ddb.commandCalls(GetCommand)).toHaveLength(0);
  });

  it('does not count anonymous requests or CORS preflights', async () => {
    ddb.on(UpdateCommand).resolves(counted(1));
    expect((await app.request('/v1/stub/whoami')).status).toBe(401);
    expect((await app.request('/v1/stub/whoami', { headers: as('bad') })).status).toBe(401);
    const preflight = await app.request('/v1/trades', { method: 'OPTIONS', headers: { origin: 'https://dev.tradequt.com', 'access-control-request-method': 'GET' } });
    expect(preflight.status).toBe(204);
    expect(ddb.commandCalls(UpdateCommand)).toHaveLength(0);
  });

  it('lets the request through when the RateLimit table fails, and logs it', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    ddb.on(GetCommand).resolves({});
    ddb.on(UpdateCommand).rejects(new Error('ProvisionedThroughputExceededException'));
    const res = await app.request('/v1/stub/whoami', { headers: as('u1') });
    expect(res.status).toBe(200);
    expect(featureRan).toBe(true);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('user_rate_limit_unavailable'));
    warn.mockRestore();
  });
});

describe('userRateLimit middleware', () => {
  const probe = (check: Parameters<typeof userRateLimit>[0]) => {
    const a = new Hono<AppEnv>();
    a.use('*', async (c, next) => {
      c.set('userId', 'u9');
      await next();
    });
    a.use('*', userRateLimit(check));
    a.get('/x', (c) => c.json({ ok: true }));
    return a;
  };

  it('asks for 600 requests per 60 s on user:<sub>', async () => {
    const check = vi.fn().mockResolvedValue({ allowed: true });
    expect((await probe(check).request('/x')).status).toBe(200);
    expect(check).toHaveBeenCalledWith({ key: 'user:u9', limit: 600, windowSeconds: 60 });
  });

  it('answers 429 with the retry time when the check refuses', async () => {
    const check = vi.fn().mockResolvedValue({ allowed: false, retryAfter: 42 });
    const res = await probe(check).request('/x');
    expect(res.status).toBe(429);
    expect(await res.json()).toMatchObject({ success: false, errorCode: 'RATE_LIMITED', error: { code: 'RATE_LIMITED', retryAfter: 42 } });
  });

  it('does nothing without a RateLimit table (local server)', async () => {
    vi.stubEnv('RATE_LIMIT_TABLE', '');
    const check = vi.fn().mockResolvedValue({ allowed: false, retryAfter: 1 });
    expect((await probe(check).request('/x')).status).toBe(200);
    expect(check).not.toHaveBeenCalled();
    vi.stubEnv('RATE_LIMIT_TABLE', 'test-rate');
  });
});
