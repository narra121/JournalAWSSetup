import { describe, expect, it, vi } from 'vitest';
import fixture from './routes.fixture.json';

vi.stubEnv('USER_POOL_ID', 'us-east-1_test');
vi.stubEnv('USER_POOL_CLIENT_ID', 'client');
vi.stubEnv('ALLOWED_ORIGINS', 'https://dev.tradequt.com');

const { createApp } = await import('../app');
const { LEGACY_ROUTES, toHonoPath } = await import('../routes');

const app = createApp();

describe('route coverage (base template 768ead7, 58 routes)', () => {
  it('registers every original route except the removed firebase-token route, with the same auth group', () => {
    const registered = new Map(LEGACY_ROUTES.map((r) => [`${r.method} ${r.path}`, r.auth]));
    const missing = fixture
      .filter((r) => r.path !== '/v1/auth/firebase-token')
      .filter((r) => registered.get(`${r.method} ${r.path}`) !== r.auth)
      .map((r) => `${r.method} ${r.path} (${r.auth})`);
    expect(missing).toEqual([]);
    expect(LEGACY_ROUTES.length).toBe(fixture.length - 1 + 3); // + GET /v1/trades/{tradeId}, POST /v1/trades/bulk-update, POST /v1/trades/restore
  });

  it('mounts every legacy route on the Hono app', () => {
    const mounted = new Set(app.routes.map((r) => `${r.method} ${r.path}`));
    for (const route of LEGACY_ROUTES) expect(mounted.has(`${route.method} ${toHonoPath(route.path)}`)).toBe(true);
  });

  it('translates API Gateway path syntax', () => {
    expect(toHonoPath('/v1/images/{imageId+}')).toBe('/v1/images/:imageId{.+}');
    expect(toHonoPath('/v1/admin/users/{userId}/stats')).toBe('/v1/admin/users/:userId/stats');
  });
});

describe('error envelopes', () => {
  it('unknown route → 404 ROUTE_NOT_FOUND', async () => {
    const res = await app.request('/v1/nope');
    expect(res.status).toBe(404);
    expect(res.headers.get('content-type')).toContain('application/json');
    expect(await res.json()).toMatchObject({ success: false, errorCode: 'ROUTE_NOT_FOUND' });
  });

  it('removed firebase-token route is unknown', async () => {
    const res = await app.request('/v1/auth/firebase-token', { method: 'POST' });
    expect(res.status).toBe(404);
  });

  it('every response carries x-request-id and no-store', async () => {
    const res = await app.request('/v1/nope');
    expect(res.headers.get('x-request-id')).toBeTruthy();
    expect(res.headers.get('cache-control')).toBe('no-store');
  });
});

describe('authentication groups', () => {
  const cognito = fixture.filter((r) => r.auth === 'cognito' && r.path !== '/v1/auth/firebase-token');
  const admin = fixture.filter((r) => r.auth === 'admin');

  it.each(cognito.map((r) => [r.method, r.path.replace(/\{[^}]+\}/g, 'x')]))('%s %s without a token → 401 Bearer', async (method, path) => {
    const res = await app.request(path, { method });
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toBe('Bearer');
    expect(await res.json()).toEqual({ message: 'Unauthorized' });
  });

  it('cognito route with an unverifiable token → 401', async () => {
    const res = await app.request('/v1/trades', { headers: { authorization: 'Bearer a.b.c' } });
    expect(res.status).toBe(401);
  });

  it.each(admin.map((r) => [r.method, r.path.replace(/\{[^}]+\}/g, 'x')]))('%s %s without a header → 401', async (method, path) => {
    const res = await app.request(path, { method });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ message: 'Unauthorized' });
  });

  it('admin route with a rejected token → 403', async () => {
    vi.stubEnv('ADMIN_JWT_SECRET_PARAM', '');
    const res = await app.request('/v1/admin/users', { headers: { authorization: 'Bearer junk' } });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ message: 'Forbidden' });
  });
});
