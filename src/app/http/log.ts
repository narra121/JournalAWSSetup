import type { MiddlewareHandler } from 'hono';
import { randomUUID } from 'node:crypto';
import type { AppEnv } from '../types';

/** Assigns `requestId`, adds `x-request-id`, defaults `Cache-Control: no-store` and writes one JSON access-log line. */
export function requestLog(): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const started = Date.now();
    const requestId = c.req.header('lambda-web-request-id') || randomUUID();
    c.set('requestId', requestId);
    await next();
    c.res.headers.set('x-request-id', requestId);
    if (!c.res.headers.has('cache-control')) c.res.headers.set('cache-control', 'no-store');
    console.log(
      JSON.stringify({
        msg: 'access',
        requestId,
        method: c.req.method,
        route: c.req.routePath,
        status: c.res.status,
        ms: Date.now() - started,
        userId: c.get('userId'),
      }),
    );
  };
}
