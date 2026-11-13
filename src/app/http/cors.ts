import type { MiddlewareHandler } from 'hono';

// Replica of the HTTP API CorsConfiguration that served the frontend until 2026-11 (measured with curl):
// allowed origin echoed + `vary: origin` + expose headers on every response; preflight answered with 204.
const ALLOW_METHODS = 'DELETE,GET,OPTIONS,PATCH,POST,PUT';
// `idempotency-key`: the web app sends it on POST /v1/trades. Keep ApiResponseHeadersPolicy in template.yaml in step.
const ALLOW_HEADERS = 'authorization,content-type,idempotency-key,x-amz-date,x-api-key';
const EXPOSE_HEADERS = 'authorization,content-type';

export function allowedOrigins(): string[] {
  return (process.env.ALLOWED_ORIGINS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

export function apiGatewayCors(getOrigins: () => string[] = allowedOrigins): MiddlewareHandler {
  return async (c, next) => {
    const origin = c.req.header('origin');
    const allowed = origin && getOrigins().includes(origin) ? origin : undefined;

    if (c.req.method === 'OPTIONS') {
      const headers = new Headers();
      if (allowed) {
        headers.set('access-control-allow-origin', allowed);
        headers.set('access-control-allow-methods', ALLOW_METHODS);
        headers.set('access-control-allow-headers', ALLOW_HEADERS);
        headers.set('access-control-max-age', '3600');
        headers.set('vary', 'origin');
      }
      return new Response(null, { status: 204, headers });
    }

    await next();

    if (allowed) {
      c.res.headers.set('access-control-allow-origin', allowed);
      c.res.headers.set('access-control-expose-headers', EXPOSE_HEADERS);
      const vary = c.res.headers.get('vary');
      if (!vary || !/\borigin\b/i.test(vary)) c.res.headers.set('vary', vary ? `${vary}, origin` : 'origin');
    }
  };
}
