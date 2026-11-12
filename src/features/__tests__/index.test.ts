import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import type { AppEnv } from '../../app/types';
import { fakeQuota } from './helpers';
import { featureRoutes } from '../index';

describe('featureRoutes', () => {
  it('exposes import, insights, chat and reports under their base paths', () => {
    expect(featureRoutes.map((r) => r.basePath)).toEqual(['/import', '/insights', '/chat', '/reports']);
  });

  it('mounts under /v1 like src/app does and serves a route with no AWS access', async () => {
    const app = new Hono<AppEnv>();
    app.use('*', async (c, next) => {
      c.set('userId', 'u1');
      c.set('quota', fakeQuota().quota);
      await next();
    });
    for (const r of featureRoutes) app.route(`/v1${r.basePath}`, r.app);
    const res = await app.request('/v1/import/sources');
    expect(res.status).toBe(200);
    expect(((await res.json()) as any).data.sources.length).toBeGreaterThanOrEqual(7);
    expect((await app.request('/v1/chat/sessions/not-an-id/messages')).status).toBe(404);
  });
});
