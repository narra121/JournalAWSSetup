import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';
import type { APIGatewayProxyEventV2 } from 'aws-lambda';

// ─── Env ───────────────────────────────────────────────────────
vi.stubEnv('RATE_LIMIT_TABLE', 'test-rate-limit');
vi.stubEnv('ADMIN_SECRET_PARAM', '/tradequt/adminSecret');
vi.stubEnv('ADMIN_JWT_SECRET_PARAM', '/tradequt/adminJwtSecret');

// ─── Rate limit mock ──────────────────────────────────────────
vi.mock('../../auth-rate-limit-wrapper/rateLimit', () => ({
  checkRateLimit: vi.fn().mockResolvedValue({ allowed: true }),
}));

// ─── SSM mock ─────────────────────────────────────────────────
const ssmMock = mockClient(SSMClient);

const ADMIN_PASSWORD = 'super-secret-admin-password';
const JWT_SECRET = 'test-jwt-secret-key-for-signing';

// ─── Helpers ──────────────────────────────────────────────────
function makeEvent(body?: any): APIGatewayProxyEventV2 {
  return {
    version: '2.0',
    routeKey: 'POST /v1/admin/login',
    rawPath: '/v1/admin/login',
    rawQueryString: '',
    headers: {},
    requestContext: {
      accountId: '123',
      apiId: 'api',
      domainName: 'api.example.com',
      domainPrefix: 'api',
      http: { method: 'POST', path: '/v1/admin/login', protocol: 'HTTP/1.1', sourceIp: '127.0.0.1', userAgent: 'test' },
      requestId: 'req-1',
      routeKey: 'POST /v1/admin/login',
      stage: '$default',
      time: '01/Jan/2024:00:00:00 +0000',
      timeEpoch: 0,
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
    isBase64Encoded: false,
  } as unknown as APIGatewayProxyEventV2;
}

function setupSsm() {
  ssmMock.on(GetParameterCommand, { Name: '/tradequt/adminSecret' }).resolves({
    Parameter: { Value: ADMIN_PASSWORD },
  });
  ssmMock.on(GetParameterCommand, { Name: '/tradequt/adminJwtSecret' }).resolves({
    Parameter: { Value: JWT_SECRET },
  });
}

// Fresh handler import to reset module-scoped caches
async function freshHandler() {
  vi.resetModules();
  vi.doMock('../../auth-rate-limit-wrapper/rateLimit', () => ({
    checkRateLimit: vi.fn().mockResolvedValue({ allowed: true }),
  }));
  const mod = await import('../app');
  return mod.handler;
}

beforeEach(() => {
  ssmMock.reset();
});

// ─── Tests ────────────────────────────────────────────────────
describe('admin-login handler', () => {
  it('returns 400 if no body', async () => {
    const handler = await freshHandler();
    setupSsm();

    const res = await handler(makeEvent(), {} as any, () => {}) as any;

    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(false);
    expect(body.errorCode).toBe('VALIDATION_ERROR');
  });

  it('returns 400 if password is missing from body', async () => {
    const handler = await freshHandler();
    setupSsm();

    const res = await handler(makeEvent({}), {} as any, () => {}) as any;

    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(false);
    expect(body.errorCode).toBe('VALIDATION_ERROR');
    expect(body.message).toContain('password');
  });

  it('returns 401 for wrong password', async () => {
    const handler = await freshHandler();
    setupSsm();

    const res = await handler(makeEvent({ password: 'wrong-password' }), {} as any, () => {}) as any;

    expect(res.statusCode).toBe(401);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(false);
    expect(body.errorCode).toBe('UNAUTHORIZED');
  });

  it('returns 200 with token for correct password', async () => {
    const handler = await freshHandler();
    setupSsm();

    const res = await handler(makeEvent({ password: ADMIN_PASSWORD }), {} as any, () => {}) as any;

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(true);
    expect(body.data.token).toBeDefined();
    expect(typeof body.data.token).toBe('string');
    expect(body.data.expiresAt).toBeDefined();
    expect(typeof body.data.expiresAt).toBe('number');
    expect(body.message).toBe('Admin login successful');
  });

  it('caches SSM parameters across invocations', async () => {
    const handler = await freshHandler();
    setupSsm();

    // First invocation
    await handler(makeEvent({ password: ADMIN_PASSWORD }), {} as any, () => {});
    // Second invocation
    await handler(makeEvent({ password: ADMIN_PASSWORD }), {} as any, () => {});

    // Should only have 2 SSM calls total (one per parameter), not 4
    const ssmCalls = ssmMock.commandCalls(GetParameterCommand);
    expect(ssmCalls).toHaveLength(2);
  });

  it('calls SSM with WithDecryption: true', async () => {
    const handler = await freshHandler();
    setupSsm();

    await handler(makeEvent({ password: ADMIN_PASSWORD }), {} as any, () => {});

    const ssmCalls = ssmMock.commandCalls(GetParameterCommand);
    expect(ssmCalls).toHaveLength(2);
    expect(ssmCalls[0].args[0].input.WithDecryption).toBe(true);
    expect(ssmCalls[1].args[0].input.WithDecryption).toBe(true);
  });

  it('returns 429 when rate limited', async () => {
    vi.resetModules();
    vi.doMock('../../auth-rate-limit-wrapper/rateLimit', () => ({
      checkRateLimit: vi.fn().mockResolvedValue({ allowed: false, retryAfter: 120 }),
    }));
    const { handler } = await import('../app');
    setupSsm();

    const res = await handler(makeEvent({ password: ADMIN_PASSWORD }), {} as any, () => {}) as any;

    expect(res.statusCode).toBe(429);
    const body = JSON.parse(res.body);
    expect(body.errorCode).toBe('RATE_LIMITED');
  });

  it('returns 500 when SSM fails', async () => {
    const handler = await freshHandler();
    ssmMock.on(GetParameterCommand).rejects(new Error('SSM timeout'));

    const res = await handler(makeEvent({ password: ADMIN_PASSWORD }), {} as any, () => {}) as any;

    expect(res.statusCode).toBe(500);
    const body = JSON.parse(res.body);
    expect(body.errorCode).toBe('INTERNAL_ERROR');
  });

  it('token contains valid expiration', async () => {
    const handler = await freshHandler();
    setupSsm();

    const res = await handler(makeEvent({ password: ADMIN_PASSWORD }), {} as any, () => {}) as any;
    const body = JSON.parse(res.body);

    const now = Math.floor(Date.now() / 1000);
    // Token should expire in the future (within 4 hours + some margin)
    expect(body.data.expiresAt).toBeGreaterThan(now);
    expect(body.data.expiresAt).toBeLessThanOrEqual(now + 4 * 60 * 60 + 10);
  });
});
