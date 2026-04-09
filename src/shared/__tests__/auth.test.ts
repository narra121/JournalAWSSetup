import { describe, it, expect } from 'vitest';
import { getUserId } from '../auth.js';

/**
 * Helper: build a minimal JWT (no signature, just header.payload.sig structure)
 * with the given claims payload.
 */
function makeJwt(payload: Record<string, any>): string {
  const header = btoa(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const body = btoa(JSON.stringify(payload));
  return `${header}.${body}.fake-signature`;
}

// ─── Production path: requestContext.authorizer.jwt.claims ──────

describe('getUserId - production path (authorizer claims)', () => {
  it('returns sub from authorizer JWT claims', () => {
    const event = {
      requestContext: {
        authorizer: { jwt: { claims: { sub: 'user-123' } } },
      },
      headers: {},
    };
    expect(getUserId(event)).toBe('user-123');
  });

  it('prefers authorizer claims over Authorization header', () => {
    const token = makeJwt({ sub: 'header-user' });
    const event = {
      requestContext: {
        authorizer: { jwt: { claims: { sub: 'claims-user' } } },
      },
      headers: { authorization: `Bearer ${token}` },
    };
    expect(getUserId(event)).toBe('claims-user');
  });
});

// ─── Fallback path: decode JWT from Authorization header ────────

describe('getUserId - header fallback', () => {
  it('decodes sub from a Bearer token', () => {
    const token = makeJwt({ sub: 'decoded-user-456' });
    const event = {
      requestContext: {},
      headers: { authorization: `Bearer ${token}` },
    };
    expect(getUserId(event)).toBe('decoded-user-456');
  });

  it('handles Authorization header with capital A', () => {
    const token = makeJwt({ sub: 'capital-user' });
    const event = {
      requestContext: {},
      headers: { Authorization: `Bearer ${token}` },
    };
    expect(getUserId(event)).toBe('capital-user');
  });

  it('handles token without Bearer prefix', () => {
    const token = makeJwt({ sub: 'no-bearer-user' });
    const event = {
      requestContext: {},
      headers: { authorization: token },
    };
    expect(getUserId(event)).toBe('no-bearer-user');
  });
});

// ─── Missing / malformed auth ───────────────────────────────────

describe('getUserId - missing/malformed auth', () => {
  it('returns undefined when no headers at all', () => {
    expect(getUserId({ requestContext: {} })).toBeUndefined();
  });

  it('returns undefined when authorization header is empty', () => {
    const event = { requestContext: {}, headers: { authorization: '' } };
    expect(getUserId(event)).toBeUndefined();
  });

  it('returns undefined when authorization header is missing', () => {
    const event = { requestContext: {}, headers: {} };
    expect(getUserId(event)).toBeUndefined();
  });

  it('returns undefined for token with no payload segment', () => {
    const event = { requestContext: {}, headers: { authorization: 'Bearer header-only' } };
    expect(getUserId(event)).toBeUndefined();
  });

  it('returns undefined for token with invalid base64 payload', () => {
    const event = { requestContext: {}, headers: { authorization: 'Bearer aaa.!!!invalid!!!.ccc' } };
    expect(getUserId(event)).toBeUndefined();
  });

  it('returns undefined when payload is valid base64 but not JSON', () => {
    const encoded = btoa('this is not json');
    const event = { requestContext: {}, headers: { authorization: `Bearer header.${encoded}.sig` } };
    expect(getUserId(event)).toBeUndefined();
  });

  it('returns undefined when payload JSON has no sub field', () => {
    const encoded = btoa(JSON.stringify({ name: 'Alice' }));
    const event = { requestContext: {}, headers: { authorization: `Bearer header.${encoded}.sig` } };
    expect(getUserId(event)).toBeUndefined();
  });

  it('returns undefined when requestContext.authorizer exists but has no jwt', () => {
    const event = {
      requestContext: { authorizer: {} },
      headers: {},
    };
    expect(getUserId(event)).toBeUndefined();
  });
});
