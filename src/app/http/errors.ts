import type { ErrorHandler, MiddlewareHandler, NotFoundHandler } from 'hono';
import { defaultsFor, errorBody, normalizeErrorBody } from '../../shared/apiError';
import type { AppEnv } from '../types';

export const notFound: NotFoundHandler<AppEnv> = (c) => c.json(errorBody('ROUTE_NOT_FOUND', "We couldn't find that page of the API."), 404);

export const onError: ErrorHandler<AppEnv> = (err, c) => {
  const requestId = c.get('requestId');
  console.error(JSON.stringify({ msg: 'unhandled_error', requestId, error: err?.message, stack: err?.stack }));
  return c.json(errorBody('INTERNAL_ERROR', defaultsFor(500).message, {}, requestId), 500);
};

/**
 * Last line of defence: every response with status >= 400 leaves as the error contract (src/shared/apiError.ts),
 * whatever a handler put in it. A 429 also gets the standard `Retry-After` header from `error.retryAfter`.
 */
export function errorContract(): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    await next();
    const res = c.res;
    if (res.status < 400 || (res.headers.get('content-type') ?? '').startsWith('text/event-stream')) return;
    const body = normalizeErrorBody(res.status, await res.clone().text());
    const headers = new Headers(res.headers);
    headers.set('content-type', 'application/json; charset=utf-8');
    headers.delete('content-length');
    if (typeof body.error?.retryAfter === 'number') headers.set('retry-after', String(Math.ceil(body.error.retryAfter)));
    c.res = new Response(JSON.stringify(body), { status: res.status, headers });
  };
}
