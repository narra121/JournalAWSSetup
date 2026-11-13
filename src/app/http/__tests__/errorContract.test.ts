import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';
import { errorBody } from '../../../shared/apiError';
import { errorResponse, ErrorCodes } from '../../../shared/validation';
import { fromLambdaResult } from '../adapter';
import { apiGatewayCors } from '../cors';
import { errorContract, notFound, onError } from '../errors';

vi.spyOn(console, 'error').mockImplementation(() => undefined);

const app = new Hono<any>();
app.use('*', apiGatewayCors(() => ['https://dev.tradequt.com']));
app.use('*', errorContract());
app.get('/ok', (c) => c.json({ success: true, message: 'Success', data: { a: 1 } }));
app.get('/contract', (c) => c.json(errorBody('VALIDATION_ERROR', 'A trade can have at most 6 images'), 400));
app.get('/string-error', (c) => c.json({ error: 'Invalid image format' }, 400));
app.get('/message-only', (c) => c.json({ message: 'Unauthorized' }, 401));
app.get('/text-502', () => new Response('<html>502 Bad Gateway</html>', { status: 502, headers: { 'content-type': 'text/html' } }));
app.get('/empty-503', () => new Response(null, { status: 503 }));
app.get('/legacy-429', () => fromLambdaResult({ statusCode: 429, body: JSON.stringify({ success: false, message: 'Too many attempts', errorCode: 'RATE_LIMITED', errors: [{ retryAfter: 41.2 }] }) }));
app.get('/lambda-envelope-429', () => fromLambdaResult(errorResponse(429, ErrorCodes.RATE_LIMITED, 'Too many attempts', { retryAfter: 41 })));
app.get('/throws', () => {
  throw new Error('DynamoDB: arn:aws:dynamodb:us-east-1:123:table/Trades blew up');
});
app.get('/sse-error', () => new Response('event: error\ndata: {}\n\n', { status: 400, headers: { 'content-type': 'text/event-stream' } }));
app.notFound(notFound);
app.onError(onError);

const get = (path: string) => app.request(path, { headers: { origin: 'https://dev.tradequt.com' } });
const assertContract = (b: any) => {
  expect(b.success).toBe(false);
  expect(typeof b.message).toBe('string');
  expect(b.message).not.toBe('');
  expect(b.errorMessage).toBe(b.message);
  expect(b.errorCode).toMatch(/^[A-Z][A-Z0-9_]*$/);
};

describe('errorContract middleware', () => {
  it('leaves success responses alone', async () => {
    const res = await get('/ok');
    expect(await res.json()).toEqual({ success: true, message: 'Success', data: { a: 1 } });
  });

  it('passes the owner example through unchanged', async () => {
    const res = await get('/contract');
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ success: false, message: 'A trade can have at most 6 images', errorCode: 'VALIDATION_ERROR', errorMessage: 'A trade can have at most 6 images' });
  });

  it.each([
    ['/string-error', 400, 'Invalid image format', 'VALIDATION_ERROR'],
    ['/message-only', 401, 'Your session has ended. Please log in again.', 'UNAUTHORIZED'],
    ['/text-502', 502, 'The service is temporarily unavailable. Please try again in a moment.', 'BAD_GATEWAY'],
    ['/empty-503', 503, 'The service is temporarily unavailable. Please try again in a moment.', 'SERVICE_UNAVAILABLE'],
  ])('%s becomes the contract', async (path, status, message, code) => {
    const res = await get(path);
    expect(res.status).toBe(status);
    expect(res.headers.get('content-type')).toContain('application/json');
    const b = await res.json();
    assertContract(b);
    expect(b).toMatchObject({ message, errorCode: code });
  });

  it('keeps CORS headers on error responses', async () => {
    const res = await get('/text-502');
    expect(res.headers.get('access-control-allow-origin')).toBe('https://dev.tradequt.com');
  });

  it('429: error.retryAfter in the body and Retry-After in the header, from either old or new shape', async () => {
    for (const path of ['/legacy-429', '/lambda-envelope-429']) {
      const res = await get(path);
      expect(res.status).toBe(429);
      const b = await res.json();
      assertContract(b);
      expect(b.error.code).toBe('RATE_LIMITED');
      expect(b.error.retryAfter).toBeGreaterThan(40);
      expect(b.errors).toBeUndefined();
      expect(res.headers.get('retry-after')).toBe(String(Math.ceil(b.error.retryAfter)));
    }
  });

  it('unknown route: contract 404 with the route code', async () => {
    const res = await get('/nope');
    expect(res.status).toBe(404);
    const b = await res.json();
    assertContract(b);
    expect(b.errorCode).toBe('ROUTE_NOT_FOUND');
  });

  it('unhandled exception: 500 with a safe sentence and requestId, never the raw text', async () => {
    const res = await get('/throws');
    expect(res.status).toBe(500);
    const text = await res.text();
    const b = JSON.parse(text);
    assertContract(b);
    expect(b.errorCode).toBe('INTERNAL_ERROR');
    expect(text).not.toMatch(/dynamodb|arn:aws|blew up/i);
  });

  it('does not touch an event stream', async () => {
    const res = await get('/sse-error');
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    expect(await res.text()).toContain('event: error');
  });
});
