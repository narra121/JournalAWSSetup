import { describe, it, expect, vi } from 'vitest';
import { getClaims, getUserId } from '../auth.js';

vi.unmock('../auth');

/** Unsigned token: must never be trusted, whatever it claims. */
function makeJwt(payload: Record<string, any>): string {
  const header = btoa(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const body = btoa(JSON.stringify(payload));
  return `${header}.${body}.fake-signature`;
}

describe('getUserId', () => {
  it('returns sub from the verified authorizer claims', () => {
    const event = { requestContext: { authorizer: { jwt: { claims: { sub: 'user-123' } } } }, headers: {} };
    expect(getUserId(event)).toBe('user-123');
  });

  it('prefers authorizer claims over the Authorization header', () => {
    const event = {
      requestContext: { authorizer: { jwt: { claims: { sub: 'claims-user' } } } },
      headers: { authorization: `Bearer ${makeJwt({ sub: 'header-user' })}` },
    };
    expect(getUserId(event)).toBe('claims-user');
  });

  it('ignores a forged Authorization header when there are no verified claims', () => {
    const forged = makeJwt({ sub: 'victim' });
    expect(getUserId({ requestContext: {}, headers: { authorization: `Bearer ${forged}` } })).toBeUndefined();
    expect(getUserId({ requestContext: {}, headers: { Authorization: forged } })).toBeUndefined();
  });

  it('returns undefined for missing or malformed events', () => {
    expect(getUserId({})).toBeUndefined();
    expect(getUserId(undefined)).toBeUndefined();
    expect(getUserId({ requestContext: { authorizer: { jwt: { claims: {} } } } })).toBeUndefined();
  });
});

describe('getClaims', () => {
  it('returns the verified claims', () => {
    const claims = { sub: 'u1', email: 'a@b.c' };
    expect(getClaims({ requestContext: { authorizer: { jwt: { claims } } } })).toEqual(claims);
  });

  it('never decodes the Authorization header', () => {
    const forged = makeJwt({ sub: 'victim', email: 'x@y.z' });
    expect(getClaims({ requestContext: {}, headers: { authorization: `Bearer ${forged}` } })).toEqual({});
  });
});
