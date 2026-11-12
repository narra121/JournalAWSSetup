import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { mockClient } from 'aws-sdk-client-mock';
import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppEnv } from '../types';

vi.stubEnv('USAGE_TABLE', 'usage');
vi.stubEnv('SUBSCRIPTIONS_TABLE', 'subs');
vi.stubEnv('USER_POOL_ID', 'us-east-1_a');
vi.stubEnv('USER_POOL_CLIENT_ID', 'c');

const ddb = mockClient(DynamoDBDocumentClient);
const { computeEntitlements } = await import('../billing/entitlements');
const { createQuota, periodResetsAt } = await import('../billing/quota');
const { metered } = await import('../billing/middleware');
const { fromLambdaResult, toApiGatewayEvent, viewerIp } = await import('../http/adapter');
const { apiGatewayCors } = await import('../http/cors');

beforeEach(() => {
  ddb.reset();
});

const day = 86400000;
const iso = (offset: number) => new Date(Date.now() + offset).toISOString();

describe('computeEntitlements', () => {
  it.each([
    ['no record', undefined, 'free', 5],
    ['active', { status: 'active' }, 'pro', 200],
    ['past_due keeps Pro', { status: 'past_due' }, 'pro', 200],
    ['cancellation_requested inside the period', { status: 'cancellation_requested', currentEnd: iso(day) }, 'pro', 200],
    ['cancellation_requested after the period', { status: 'cancellation_requested', currentEnd: iso(-day) }, 'free', 5],
    ['trial running', { status: 'trial', trialEnd: iso(day) }, 'trial', 200],
    ['trial expired', { status: 'trial', trialEnd: iso(-day) }, 'free', 5],
    ['cancelled with a running trial', { status: 'cancelled', trialEnd: iso(day) }, 'trial', 200],
    ['cancelled', { status: 'cancelled' }, 'free', 5],
    ['admin grant still valid', { status: 'active', source: 'admin_grant', periodEnd: iso(day) }, 'pro', 200],
    ['admin grant expired', { status: 'active', source: 'admin_grant', periodEnd: iso(-day) }, 'free', 5],
  ])('%s → %s', (_n, sub, plan, extract) => {
    const e = computeEntitlements(sub as any);
    expect(e.plan).toBe(plan);
    expect(e.limits.ai_extract).toBe(extract);
    expect(Object.values(e.features).every((v) => v === (plan !== 'free'))).toBe(true);
  });

  it('free limits are 5/1/10/3 and trial/pro 200/30/500/200', () => {
    expect(computeEntitlements(undefined).limits).toEqual({ ai_extract: 5, ai_insight: 1, ai_chat: 10, broker_import: 3 });
    expect(computeEntitlements({ status: 'active' }).limits).toEqual({ ai_extract: 200, ai_insight: 30, ai_chat: 500, broker_import: 200 });
  });
});

describe('plan status and billing facts (BE-E5)', () => {
  const end = iso(30 * day);

  it.each([
    ['no record', undefined, 'free'],
    ['trial running', { status: 'trial', trialEnd: iso(day) }, 'trialing'],
    ['active', { status: 'active' }, 'active'],
    ['past_due', { status: 'past_due' }, 'past_due'],
    ['cancelled at period end', { status: 'cancellation_requested', currentEnd: end }, 'canceling'],
    ['trial over', { status: 'trial', trialEnd: iso(-day) }, 'free'],
    ['ended', { status: 'cancelled' }, 'free'],
  ])('%s → status %s', (_n, sub, status) => {
    expect(computeEntitlements(sub as any).status).toBe(status);
  });

  it('a renewing paid plan reports interval, amount in major units, currency and renewsAt', () => {
    const e = computeEntitlements({ status: 'active', interval: 'year', amount: 7900, currency: 'USD', currentEnd: end });
    expect(e).toMatchObject({ interval: 'year', amount: 79, currency: 'USD', renewsAt: end });
    expect(e.endsAt).toBeUndefined();
  });

  it('a plan cancelled at period end reports endsAt instead of renewsAt', () => {
    const e = computeEntitlements({ status: 'cancellation_requested', interval: 'month', amount: 19900, currency: 'INR', currentEnd: end });
    expect(e).toMatchObject({ status: 'canceling', endsAt: end, amount: 199 });
    expect(e.renewsAt).toBeUndefined();
  });

  it('an expired trial reports trialEndedAt; a running trial reports trialEndsAt', () => {
    const past = iso(-2 * day);
    expect(computeEntitlements({ status: 'trial', trialEnd: past }).trialEndedAt).toBe(past);
    expect(computeEntitlements({ status: 'trial', trialEnd: end }).trialEndsAt).toBe(end);
  });

  it('flags a subscription on a price that is no longer a current Pro price', () => {
    expect(computeEntitlements({ status: 'active', planId: 'price_old' }, new Date(), ['price_new']).legacyPrice).toBe(true);
    expect(computeEntitlements({ status: 'active', planId: 'price_new' }, new Date(), ['price_new']).legacyPrice).toBe(false);
    expect(computeEntitlements({ status: 'active', planId: 'price_new' }).legacyPrice).toBeUndefined();
  });

  it('an admin grant reports its end date and never a renewal', () => {
    const e = computeEntitlements({ status: 'active', source: 'admin_grant', periodEnd: end });
    expect(e).toMatchObject({ plan: 'pro', status: 'active', endsAt: end });
    expect(e.renewsAt).toBeUndefined();
  });
});

describe('quota', () => {
  const free = computeEntitlements(undefined);

  it('returns ok:false with the next month reset when the condition fails', async () => {
    ddb.on(UpdateCommand).rejects(new ConditionalCheckFailedException({ message: 'x', $metadata: {} }));
    const r = await createQuota('u', free, () => new Date('2026-11-15T10:00:00Z')).consume('ai_extract');
    expect(r).toEqual({ ok: false, limit: 5, resetsAt: '2026-12-01T00:00:00.000Z' });
  });

  it('refund is unconditional', async () => {
    ddb.on(UpdateCommand).resolves({ Attributes: { count: 0 } });
    await createQuota('u', free).consume('ai_chat', -1);
    const input = ddb.commandCalls(UpdateCommand)[0].args[0].input;
    expect(input.ConditionExpression).toBeUndefined();
    expect(input.ExpressionAttributeValues![':n']).toBe(-1);
  });

  it('resets on the first of next month (UTC, including December)', () => {
    expect(periodResetsAt(new Date('2026-12-31T23:59:59Z'))).toBe('2027-01-01T00:00:00.000Z');
  });

  it('metered() answers 402 QUOTA_EXCEEDED and skips the handler when the quota is spent', async () => {
    ddb.on(GetCommand).resolves({});
    ddb.on(UpdateCommand).rejects(new ConditionalCheckFailedException({ message: 'x', $metadata: {} }));
    const app = new Hono<AppEnv>();
    app.use('*', async (c, next) => {
      c.set('entitlements', free);
      c.set('quota', createQuota('u', free));
      await next();
    });
    const handler = vi.fn((c) => c.json({ ok: true }));
    app.post('/x', metered('ai_extract'), handler);
    const res = await app.request('/x', { method: 'POST' });
    expect(res.status).toBe(402);
    const body = await res.json();
    expect(body).toMatchObject({ success: false, errorCode: 'QUOTA_EXCEEDED', error: { code: 'QUOTA_EXCEEDED', feature: 'ai_extract', limit: 5, plan: 'free' } });
    expect(handler).not.toHaveBeenCalled();
  });

  it('metered() refunds the unit when the handler fails (status >= 400)', async () => {
    ddb.on(UpdateCommand).resolves({ Attributes: { count: 1 } });
    const app = new Hono<AppEnv>();
    app.use('*', async (c, next) => {
      c.set('entitlements', free);
      c.set('quota', createQuota('u', free));
      await next();
    });
    app.post('/x', metered('ai_extract'), (c) => c.json({ success: false }, 500));
    await app.request('/x', { method: 'POST' });
    const calls = ddb.commandCalls(UpdateCommand).map((c) => c.args[0].input.ExpressionAttributeValues![':n']);
    expect(calls).toEqual([1, -1]);
  });
});

describe('adapter', () => {
  it('maps a Hono request to an API Gateway v2 event', async () => {
    const app = new Hono<AppEnv>();
    let event: any;
    app.post('/v1/things/:id', async (c) => {
      c.set('requestId', 'rid');
      event = await toApiGatewayEvent(c, 'POST /v1/things/{id}');
      return c.text('ok');
    });
    await app.request('/v1/things/42?a=1&a=2&b=x', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': '1.2.3.4, 5.6.7.8', Authorization: 'Bearer t' },
      body: '{"k":1}',
    });
    expect(event).toMatchObject({
      version: '2.0',
      routeKey: 'POST /v1/things/{id}',
      rawPath: '/v1/things/42',
      rawQueryString: 'a=1&a=2&b=x',
      queryStringParameters: { a: '1,2', b: 'x' },
      pathParameters: { id: '42' },
      body: '{"k":1}',
      isBase64Encoded: false,
    });
    expect(event.headers.authorization).toBe('Bearer t');
    expect(event.requestContext.http).toMatchObject({ method: 'POST', sourceIp: '1.2.3.4' });
  });

  it('keeps binary request bodies base64-encoded', async () => {
    const app = new Hono<AppEnv>();
    let event: any;
    app.post('/b', async (c) => {
      event = await toApiGatewayEvent(c, 'POST /b');
      return c.text('ok');
    });
    await app.request('/b', { method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: new Uint8Array([1, 2, 3]) });
    expect(event.isBase64Encoded).toBe(true);
    expect(event.body).toBe(Buffer.from([1, 2, 3]).toString('base64'));
  });

  it('takes the viewer IP as the second-to-last X-Forwarded-For entry', () => {
    expect(viewerIp('9.9.9.9, 1.1.1.1, 2.2.2.2')).toBe('1.1.1.1');
    expect(viewerIp('1.1.1.1')).toBe('1.1.1.1');
    expect(viewerIp(undefined, '8.8.8.8')).toBe('8.8.8.8');
  });

  it('maps handler results like API Gateway: status, headers, base64 body, JSON-looking text', async () => {
    const r = fromLambdaResult({ statusCode: 201, headers: { 'X-A': 'b' }, body: '{"a":1}' });
    expect(r.status).toBe(201);
    expect(r.headers.get('x-a')).toBe('b');
    expect(r.headers.get('content-type')).toContain('application/json');
    const bin = fromLambdaResult({ statusCode: 200, headers: { 'content-type': 'image/png' }, isBase64Encoded: true, body: Buffer.from([7, 8]).toString('base64') });
    expect([...new Uint8Array(await bin.arrayBuffer())]).toEqual([7, 8]);
    expect(fromLambdaResult({ statusCode: 204 }).status).toBe(204);
    expect(await fromLambdaResult({ a: 1 }).json()).toEqual({ a: 1 });
  });
});

describe('cors (replica of the API Gateway configuration)', () => {
  const app = new Hono();
  app.use('*', apiGatewayCors(() => ['https://dev.tradequt.com']));
  app.get('/x', (c) => c.json({}, 401));

  it('echoes an allowed origin on every response including errors', async () => {
    const res = await app.request('/x', { headers: { origin: 'https://dev.tradequt.com' } });
    expect(res.status).toBe(401);
    expect(res.headers.get('access-control-allow-origin')).toBe('https://dev.tradequt.com');
    expect(res.headers.get('access-control-expose-headers')).toBe('authorization,content-type');
    expect(res.headers.get('vary')).toBe('origin');
  });

  it('answers preflight with 204 and the exact allow lists', async () => {
    const res = await app.request('/x', { method: 'OPTIONS', headers: { origin: 'https://dev.tradequt.com' } });
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-methods')).toBe('DELETE,GET,OPTIONS,PATCH,POST,PUT');
    expect(res.headers.get('access-control-allow-headers')).toBe('authorization,content-type,x-amz-date,x-api-key');
    expect(res.headers.get('access-control-max-age')).toBe('3600');
  });

  it('disallowed origin → no CORS headers (preflight still 204)', async () => {
    const res = await app.request('/x', { method: 'OPTIONS', headers: { origin: 'https://evil.example' } });
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
  });
});
