import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, QueryCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { GetParameterCommand, SSMClient } from '@aws-sdk/client-ssm';
import { mockClient } from 'aws-sdk-client-mock';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.stubEnv('USER_POOL_ID', 'us-east-1_test');
vi.stubEnv('USER_POOL_CLIENT_ID', 'client');
vi.stubEnv('ALLOWED_ORIGINS', 'https://dev.tradequt.com');
vi.stubEnv('TRADES_TABLE', 'test-trades');
vi.stubEnv('SUBSCRIPTIONS_TABLE', 'test-subs');
vi.stubEnv('USAGE_TABLE', 'test-usage');
vi.stubEnv('RATE_LIMIT_TABLE', 'test-rate');
vi.stubEnv('IMAGES_BUCKET', 'test-bucket');
vi.spyOn(console, 'error').mockImplementation(() => undefined);
vi.spyOn(console, 'warn').mockImplementation(() => undefined);
vi.spyOn(console, 'log').mockImplementation(() => undefined);

const ddbMock = mockClient(DynamoDBDocumentClient);
const ssmMock = mockClient(SSMClient);
const { createApp } = await import('../app');
const { setTokenVerifier } = await import('../auth/cognito');
const { chatApp } = await import('../../features/chat/routes');

setTokenVerifier({ verify: async () => ({ sub: 'user-1', email: 'a@example.com' }) });
const app = createApp({ featureRoutes: [{ basePath: '/chat', app: chatApp() }] });

const send = (method: string, path: string, body?: unknown, auth = true) =>
  app.request(path, {
    method,
    headers: { origin: 'https://dev.tradequt.com', 'content-type': 'application/json', ...(auth ? { authorization: 'Bearer valid' } : {}) },
    ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }),
  });

/** The contract every family below must produce. */
async function expectContract(res: Response, status: number) {
  expect(res.status).toBe(status);
  expect(res.headers.get('content-type')).toContain('application/json');
  expect(res.headers.get('access-control-allow-origin')).toBe('https://dev.tradequt.com');
  const text = await res.text();
  const b = JSON.parse(text);
  expect(b.success).toBe(false);
  expect(typeof b.message).toBe('string');
  expect(b.message.length).toBeGreaterThan(0);
  expect(b.errorMessage).toBe(b.message);
  expect(b.errorCode).toMatch(/^[A-Z][A-Z0-9_]*$/);
  if (b.error !== undefined) expect(b.error.code).toBe(b.errorCode);
  expect(Object.keys(b).filter((k) => !['success', 'message', 'errorCode', 'errorMessage', 'error', 'requestId'].includes(k))).toEqual([]);
  expect(text).not.toMatch(/arn:aws|dynamodb|stack/i);
  return b;
}

beforeEach(() => {
  ddbMock.reset();
  ddbMock.on(GetCommand, { TableName: 'test-trades' }).resolves({ Item: { userId: 'user-1', tradeId: 'trade-1', symbol: 'AAPL', side: 'BUY', quantity: 1, entryPrice: 1, images: [] } });
  ddbMock.on(GetCommand, { TableName: 'test-subs' }).resolves({});
  ddbMock.on(QueryCommand).resolves({ Items: [] });
  ddbMock.on(UpdateCommand).resolves({ Attributes: { count: 1 } });
});

describe('every family answers with the one error contract', () => {
  it('trades: more than 6 images (the owner example)', async () => {
    const images = Array.from({ length: 7 }, (_, i) => ({ id: `img-${i}`, url: `images/user-1/trade-1/${i}.png` }));
    const b = await expectContract(await send('PUT', '/v1/trades/trade-1', { images }), 400);
    expect(b).toEqual({ success: false, message: 'A trade can have at most 6 images', errorCode: 'VALIDATION_ERROR', errorMessage: 'A trade can have at most 6 images' });
  });

  it('trades: not found reads as a sentence', async () => {
    ddbMock.on(GetCommand, { TableName: 'test-trades' }).resolves({});
    const b = await expectContract(await send('PUT', '/v1/trades/missing', { notes: 'x' }), 404);
    expect(b.errorCode).toBe('NOT_FOUND');
    expect(b.message).toBe("We couldn't find what you asked for.");
  });

  it('trades: schema failure names the first field problem and lists every one under error.fields', async () => {
    const b = await expectContract(await send('POST', '/v1/trades', { symbol: 123 }), 400);
    expect(b.errorCode).toBe('VALIDATION_ERROR');
    expect(b.message).toBe(`${b.error.fields[0].message} (and ${b.error.fields.length - 1} more)`);
    expect(b.error.fields).toContainEqual({ field: 'symbol', message: 'Symbol must be text' });
    expect(b.error.fields).toContainEqual({ field: 'side', message: 'Side is required' });
    expect(b.errors).toBeUndefined();
  });

  it('auth: 429 carries error.retryAfter and Retry-After', async () => {
    ddbMock.on(UpdateCommand).resolves({ Attributes: { count: 99, ttl: Math.floor(Date.now() / 1000) + 120 } });
    const res = await send('POST', '/v1/auth/login', { email: 'a@example.com', password: 'x' }, false);
    const b = await expectContract(res, 429);
    expect(b.errorCode).toBe('RATE_LIMITED');
    expect(b.error.retryAfter).toBeGreaterThan(100);
    expect(b.error.retryAfter).toBeLessThanOrEqual(120);
    expect(res.headers.get('retry-after')).toBe(String(b.error.retryAfter));
    expect(b.errors).toBeUndefined();
  });

  it('auth: missing body', async () => {
    const b = await expectContract(await send('POST', '/v1/auth/login', undefined, false), 400);
    expect(b.errorCode).toBe('VALIDATION_ERROR');
  });

  it('auth middleware: no token and an invalid token', async () => {
    setTokenVerifier({ verify: async () => { throw new Error('jwt expired'); } });
    try {
      const noToken = await expectContract(await send('GET', '/v1/trades', undefined, false), 401);
      expect(noToken.errorCode).toBe('UNAUTHORIZED');
      const badToken = await expectContract(await send('GET', '/v1/trades'), 401);
      expect(badToken.message).toBe('Your session has ended. Please log in again.');
    } finally {
      setTokenVerifier({ verify: async () => ({ sub: 'user-1', email: 'a@example.com' }) });
    }
  });

  it('admin: missing token is 401, rejected token is 403', async () => {
    expect((await expectContract(await send('GET', '/v1/admin/users', undefined, false), 401)).errorCode).toBe('UNAUTHORIZED');
    vi.stubEnv('ADMIN_JWT_SECRET_PARAM', '/tradequt/adminJwtSecret');
    ssmMock.on(GetParameterCommand).resolves({ Parameter: { Value: 'test-admin-secret' } });
    expect((await expectContract(await send('GET', '/v1/admin/users'), 403)).errorCode).toBe('FORBIDDEN');
  });

  it('admin: a missing secret or an SSM outage is a 500 with a requestId, not a 403 (BE-081)', async () => {
    vi.stubEnv('ADMIN_JWT_SECRET_PARAM', '');
    (await import('../../handlers/admin-authorizer/app'))._clearSecretCache();
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const body = await expectContract(await send('GET', '/v1/admin/users'), 500);
    expect(body.errorCode).toBe('INTERNAL_ERROR');
    expect(spy.mock.calls.some((c) => String(c[0]).includes('admin_authorizer_error'))).toBe(true);
    spy.mockRestore();
  });

  it('billing: an exhausted quota is a 402 with the quota data under error and a readable sentence', async () => {
    ddbMock.on(UpdateCommand).rejects(new ConditionalCheckFailedException({ message: 'The conditional request failed', $metadata: {} }));
    const b = await expectContract(await send('POST', '/v1/trades/extract', { textContent: 'AAPL buy' }), 402);
    expect(b.errorCode).toBe('QUOTA_EXCEEDED');
    expect(b.error).toMatchObject({ code: 'QUOTA_EXCEEDED', feature: 'ai_extract', plan: 'free' });
    expect(b.message).toMatch(/^You've used all \d+ AI trade extractions this month\. Your limit resets on \d{4}-\d{2}-\d{2}\.$/);
  });

  it('billing: a Pro-only feature is a 402 PLAN_REQUIRED', async () => {
    const b = await expectContract(await send('GET', '/v1/stats?sections=advanced'), 402);
    expect(b.errorCode).toBe('PLAN_REQUIRED');
    expect(b.error).toMatchObject({ feature: 'advanced_analytics', requiredPlan: 'pro' });
    expect(b.message).toBe('Advanced analytics is part of the Pro plan.');
  });

  it('features: chat validation and not-found use the same shape', async () => {
    const empty = await expectContract(await send('POST', '/v1/chat/sessions', '[]'), 400);
    expect(empty.errorCode).toBe('VALIDATION_ERROR');
    ddbMock.on(GetCommand).resolves({});
    const missing = await expectContract(await send('POST', '/v1/chat/sessions/none/messages', { content: 'hi' }), 404);
    expect(missing.errorCode).toBe('NOT_FOUND');
  });

  it('uploads: a trader-readable type and size message', async () => {
    expect((await expectContract(await send('POST', '/v1/uploads/images', { contentType: 'image/gif', size: 100 }), 400)).message).toBe('Screenshots must be PNG, JPEG or WebP images.');
    expect((await expectContract(await send('POST', '/v1/uploads/images', { contentType: 'image/png', size: 3 * 1024 * 1024 }), 400)).message).toBe('Screenshots can be at most 2 MB.');
  });

  it('get-image: bad extension', async () => {
    const b = await expectContract(await send('GET', '/v1/images/x.txt'), 400);
    expect(b.message).toBe('Only JPG, PNG, GIF and WebP images can be shown.');
  });

  it('webhook: missing signature', async () => {
    const b = await expectContract(await send('POST', '/v1/payments/webhook', { a: 1 }, false), 400);
    expect(b.errorCode).toBe('MISSING_SIGNATURE');
  });

  it('unknown route and wrong method', async () => {
    expect((await expectContract(await send('GET', '/v1/nope'), 404)).errorCode).toBe('ROUTE_NOT_FOUND');
    expect((await expectContract(await send('DELETE', '/v1/subscriptions/plans'), 404)).errorCode).toBe('ROUTE_NOT_FOUND');
  });

  it('journal: validation', async () => {
    const b = await expectContract(await send('GET', '/v1/journal/days?from=bad'), 400);
    expect(b.message).toBe('Use dates like 2026-11-12 for from and to.');
  });
});
