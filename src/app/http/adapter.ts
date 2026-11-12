import type { Context, Handler } from 'hono';
import type { AppEnv } from '../types';

/** Any of the existing `src/handlers/*` entry points (API Gateway HTTP API payload v2 in, proxy result out). */
export type LegacyHandler = (...args: any[]) => any;

// API Gateway passes these bodies as text; everything else arrives base64-encoded with isBase64Encoded=true.
const TEXT_CONTENT = /^(text\/|application\/(json|javascript|xml|x-www-form-urlencoded|[\w.+-]*\+(json|xml)))/i;

/** Viewer IP: CloudFront appends the viewer to X-Forwarded-For, then Lambda appends the CloudFront address. */
export function viewerIp(xff: string | undefined, fallback = ''): string {
  const parts = (xff || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (parts.length >= 2) return parts[parts.length - 2];
  return parts[0] || fallback;
}

export async function toApiGatewayEvent(c: Context<AppEnv>, routeKey: string): Promise<any> {
  const req = c.req.raw;
  const url = new URL(req.url);

  const headers: Record<string, string> = {};
  req.headers.forEach((value, key) => {
    headers[key.toLowerCase()] = value;
  });

  let queryStringParameters: Record<string, string> | undefined;
  for (const [k, v] of url.searchParams) {
    queryStringParameters ??= {};
    queryStringParameters[k] = k in queryStringParameters ? `${queryStringParameters[k]},${v}` : v;
  }

  const params = c.req.param() as Record<string, string>;
  const pathParameters = Object.keys(params).length ? { ...params } : undefined;

  let body: string | undefined;
  let isBase64Encoded = false;
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    const buf = Buffer.from(await req.arrayBuffer());
    if (buf.length) {
      const ct = headers['content-type'] || '';
      if (!ct || TEXT_CONTENT.test(ct)) body = buf.toString('utf8');
      else {
        body = buf.toString('base64');
        isBase64Encoded = true;
      }
    }
  }

  const claims = c.get('claims');
  const requestId = c.get('requestId');
  const now = new Date();
  const socketIp = (c.env as any)?.incoming?.socket?.remoteAddress || '';

  return {
    version: '2.0',
    routeKey,
    rawPath: url.pathname,
    rawQueryString: url.search.replace(/^\?/, ''),
    cookies: headers.cookie ? headers.cookie.split(/;\s*/) : undefined,
    headers,
    queryStringParameters,
    pathParameters,
    body,
    isBase64Encoded,
    requestContext: {
      accountId: 'web-function',
      apiId: 'web-function',
      domainName: headers.host || url.host,
      domainPrefix: (headers.host || url.host).split('.')[0],
      http: {
        method: req.method,
        path: url.pathname,
        protocol: 'HTTP/1.1',
        sourceIp: viewerIp(headers['x-forwarded-for'], socketIp),
        userAgent: headers['user-agent'] || '',
      },
      requestId,
      routeKey,
      stage: '$default',
      time: now.toUTCString(),
      timeEpoch: now.getTime(),
      authorizer: claims ? { jwt: { claims, scopes: null } } : undefined,
    },
  };
}

/** API Gateway HTTP API (payload v2) semantics for converting a handler result into an HTTP response. */
export function fromLambdaResult(result: any): Response {
  if (result === undefined || result === null) return new Response(null, { status: 200 });
  if (typeof result !== 'object' || !('statusCode' in result)) {
    return new Response(JSON.stringify(result), {
      status: 200,
      headers: { 'content-type': 'application/json; charset=utf-8' },
    });
  }

  const status = Number(result.statusCode) || 200;
  const headers = new Headers();
  for (const [k, v] of Object.entries(result.headers || {})) {
    if (v !== undefined && v !== null) headers.set(k, String(v));
  }
  for (const cookie of result.cookies || []) headers.append('set-cookie', cookie);

  const noBody = status === 204 || status === 304 || result.body === undefined || result.body === null;
  if (noBody) return new Response(null, { status, headers });

  const raw: string = typeof result.body === 'string' ? result.body : JSON.stringify(result.body);
  if (!headers.has('content-type')) {
    headers.set('content-type', /^\s*[[{]/.test(raw) ? 'application/json; charset=utf-8' : 'text/plain; charset=utf-8');
  }
  const payload = result.isBase64Encoded ? Buffer.from(raw, 'base64') : raw;
  return new Response(payload, { status, headers });
}

/** Mount an existing Lambda handler as a Hono route handler, preserving its request/response contract. */
export function lambdaRoute(handler: LegacyHandler, routeKey: string): Handler<AppEnv> {
  return async (c) => {
    const event = await toApiGatewayEvent(c, routeKey);
    const context = {
      awsRequestId: c.get('requestId'),
      functionName: process.env.AWS_LAMBDA_FUNCTION_NAME || 'tradequt-api',
      getRemainingTimeInMillis: () => 30_000,
    };
    return fromLambdaResult(await handler(event, context));
  };
}
