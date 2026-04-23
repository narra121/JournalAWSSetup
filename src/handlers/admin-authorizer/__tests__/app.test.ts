import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';
import jwt from 'jsonwebtoken';

vi.stubEnv('ADMIN_JWT_SECRET_PARAM', '/tradequt/adminJwtSecret');

const ssmMock = mockClient(SSMClient);

const TEST_SECRET = 'test-admin-jwt-secret-key-for-unit-tests';
const WRONG_SECRET = 'wrong-secret-that-should-not-work';

const { handler, _clearSecretCache } = await import('../app');

// ─── Helpers ─────────────────────────────────────────────────────

function makeEvent(authorization?: string) {
  return {
    headers: authorization !== undefined ? { authorization } : {},
  };
}

function signToken(secret: string, options?: jwt.SignOptions): string {
  return jwt.sign({ role: 'admin' }, secret, { expiresIn: '4h', ...options });
}

// ─── Tests ───────────────────────────────────────────────────────

beforeEach(() => {
  ssmMock.reset();
  _clearSecretCache();
  ssmMock.on(GetParameterCommand).resolves({
    Parameter: { Value: TEST_SECRET },
  });
});

describe('admin-authorizer handler', () => {
  // ── 1. Denies when no Authorization header ──

  it('denies when no Authorization header is present', async () => {
    const res = await handler(makeEvent());
    expect(res).toEqual({ isAuthorized: false });
  });

  it('denies when Authorization header is empty string', async () => {
    const res = await handler(makeEvent(''));
    expect(res).toEqual({ isAuthorized: false });
  });

  // ── 2. Denies malformed Authorization header ──

  it('denies when Authorization header has no Bearer prefix', async () => {
    const token = signToken(TEST_SECRET);
    const res = await handler(makeEvent(token));
    expect(res).toEqual({ isAuthorized: false });
  });

  it('denies when Authorization header is just "Bearer"', async () => {
    const res = await handler(makeEvent('Bearer'));
    expect(res).toEqual({ isAuthorized: false });
  });

  // ── 3. Denies expired token ──

  it('denies an expired token', async () => {
    const token = jwt.sign({ role: 'admin' }, TEST_SECRET, { expiresIn: '-1s' });
    const res = await handler(makeEvent(`Bearer ${token}`));
    expect(res).toEqual({ isAuthorized: false });
  });

  // ── 4. Denies token signed with wrong secret ──

  it('denies a token signed with the wrong secret', async () => {
    const token = signToken(WRONG_SECRET);
    const res = await handler(makeEvent(`Bearer ${token}`));
    expect(res).toEqual({ isAuthorized: false });
  });

  // ── 5. Allows valid token ──

  it('allows a valid admin token', async () => {
    const token = signToken(TEST_SECRET);
    const res = await handler(makeEvent(`Bearer ${token}`));
    expect(res).toEqual({ isAuthorized: true });
  });

  // ── 6. Case-insensitive header lookup ──

  it('reads Authorization header case-insensitively', async () => {
    const token = signToken(TEST_SECRET);
    const res = await handler({ headers: { Authorization: `Bearer ${token}` } });
    expect(res).toEqual({ isAuthorized: true });
  });

  // ── 7. Caches SSM secret ──

  it('caches the JWT secret across invocations', async () => {
    const token = signToken(TEST_SECRET);

    await handler(makeEvent(`Bearer ${token}`));
    await handler(makeEvent(`Bearer ${token}`));

    expect(ssmMock.commandCalls(GetParameterCommand)).toHaveLength(1);
  });

  // ── 8. Denies when SSM call fails ──

  it('denies when SSM call fails', async () => {
    _clearSecretCache();
    ssmMock.reset();
    ssmMock.on(GetParameterCommand).rejects(new Error('SSM unavailable'));

    const token = signToken(TEST_SECRET);
    const res = await handler(makeEvent(`Bearer ${token}`));
    expect(res).toEqual({ isAuthorized: false });
  });

  // ── 9. Denies token with wrong role ──

  it('denies a token with a non-admin role', async () => {
    const token = jwt.sign({ role: 'user' }, TEST_SECRET, { expiresIn: '4h' });
    const res = await handler(makeEvent(`Bearer ${token}`));
    expect(res).toEqual({ isAuthorized: false });
  });

  // ── 10. Denies when headers object is missing ──

  it('denies when headers object is undefined', async () => {
    const res = await handler({});
    expect(res).toEqual({ isAuthorized: false });
  });
});
