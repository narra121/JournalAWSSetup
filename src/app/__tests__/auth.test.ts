import { createSign, generateKeyPairSync } from 'node:crypto';
import { CognitoJwtVerifier } from 'aws-jwt-verify';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.stubEnv('USER_POOL_ID', 'us-east-1_abc123');
vi.stubEnv('USER_POOL_CLIENT_ID', 'client-1');

const { createApp } = await import('../app');
const { setTokenVerifier, stringifyClaims, verifyBearer } = await import('../auth/cognito');

const ISSUER = 'https://cognito-idp.us-east-1.amazonaws.com/us-east-1_abc123';

function makeKey(kid: string) {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  return { privateKey, jwk: { ...publicKey.export({ format: 'jwk' }), kid, alg: 'RS256', use: 'sig' } };
}

const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');

function sign(key: ReturnType<typeof makeKey>, claims: Record<string, unknown>, kid = 'k1') {
  const head = `${b64({ alg: 'RS256', kid, typ: 'JWT' })}.${b64(claims)}`;
  const sig = createSign('RSA-SHA256').update(head).sign(key.privateKey).toString('base64url');
  return `${head}.${sig}`;
}

const now = Math.floor(Date.now() / 1000);
const idClaims = { sub: 'user-1', email: 'a@b.c', iss: ISSUER, aud: 'client-1', token_use: 'id', exp: now + 3600, iat: now };
const accessClaims = { sub: 'user-1', iss: ISSUER, client_id: 'client-1', token_use: 'access', exp: now + 3600, iat: now };

const trusted = makeKey('k1');
const attacker = makeKey('k1');

function useRealVerifier() {
  const verifier = CognitoJwtVerifier.create({ userPoolId: 'us-east-1_abc123', clientId: 'client-1', tokenUse: null });
  verifier.cacheJwks({ keys: [trusted.jwk as any] });
  setTokenVerifier(verifier as any);
}

afterEach(() => setTokenVerifier(undefined));

describe('verifyBearer (aws-jwt-verify against a local JWKS)', () => {
  it('accepts a signed id token and stringifies claims', async () => {
    useRealVerifier();
    const claims = await verifyBearer(`Bearer ${sign(trusted, idClaims)}`);
    expect(claims?.sub).toBe('user-1');
    expect(claims?.email).toBe('a@b.c');
    expect(typeof claims?.exp).toBe('string');
  });

  it('accepts a signed access token', async () => {
    useRealVerifier();
    expect((await verifyBearer(sign(trusted, accessClaims)))?.sub).toBe('user-1');
  });

  it('rejects a token forged with another key but the same kid and claims', async () => {
    useRealVerifier();
    expect(await verifyBearer(`Bearer ${sign(attacker, idClaims)}`)).toBeUndefined();
  });

  it('rejects an unsigned token, an expired token, a wrong audience and a wrong issuer', async () => {
    useRealVerifier();
    const unsigned = `${b64({ alg: 'RS256', kid: 'k1' })}.${b64(idClaims)}.c2ln`;
    expect(await verifyBearer(unsigned)).toBeUndefined();
    expect(await verifyBearer(sign(trusted, { ...idClaims, exp: now - 10 }))).toBeUndefined();
    expect(await verifyBearer(sign(trusted, { ...idClaims, aud: 'other' }))).toBeUndefined();
    expect(await verifyBearer(sign(trusted, { ...idClaims, iss: 'https://evil.example/pool' }))).toBeUndefined();
  });

  it('returns undefined for a missing header', async () => {
    expect(await verifyBearer(undefined)).toBeUndefined();
    expect(await verifyBearer('Bearer ')).toBeUndefined();
  });
});

describe('stringifyClaims', () => {
  it('renders numbers, booleans and arrays like the API Gateway authorizer', () => {
    expect(stringifyClaims({ a: 1, b: true, c: ['x', 'y'], d: null })).toEqual({ a: '1', b: 'true', c: '[x y]' });
  });
});

describe('createApp with a forged token', () => {
  it('GET /v1/trades with a forged RS256 token → 401', async () => {
    useRealVerifier();
    vi.stubEnv('ALLOWED_ORIGINS', 'https://dev.tradequt.com');
    const res = await createApp().request('/v1/trades?limit=1', {
      headers: { authorization: `Bearer ${sign(attacker, idClaims)}` },
    });
    expect(res.status).toBe(401);
  });
});
