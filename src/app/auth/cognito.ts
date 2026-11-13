import type { MiddlewareHandler } from 'hono';
import { CognitoJwtVerifier } from 'aws-jwt-verify';
import { defaultsFor, errorBody } from '../../shared/apiError';
import type { AppEnv } from '../types';

export type TokenVerifier = { verify(token: string): Promise<Record<string, unknown>> };

let verifier: TokenVerifier | undefined;

/** Test seam: replaces the verifier built from USER_POOL_ID / USER_POOL_CLIENT_ID. */
export function setTokenVerifier(v: TokenVerifier | undefined): void {
  verifier = v;
}

function getVerifier(): TokenVerifier {
  verifier ??= CognitoJwtVerifier.create({
    userPoolId: process.env.USER_POOL_ID!,
    clientId: process.env.USER_POOL_CLIENT_ID!,
    tokenUse: null,
  }) as unknown as TokenVerifier;
  return verifier;
}

/** Claims rendered as strings exactly like the API Gateway JWT authorizer did (arrays become `[a b]`). */
export function stringifyClaims(payload: Record<string, unknown>): Record<string, string> {
  const claims: Record<string, string> = {};
  for (const [k, v] of Object.entries(payload)) {
    if (v === undefined || v === null) continue;
    if (Array.isArray(v)) claims[k] = `[${v.join(' ')}]`;
    else if (typeof v === 'object') claims[k] = JSON.stringify(v);
    else claims[k] = String(v);
  }
  return claims;
}

/** Returns the verified claims, or undefined when the header is absent or the signature/audience/expiry is invalid. */
export async function verifyBearer(header: string | undefined): Promise<Record<string, string> | undefined> {
  if (!header) return undefined;
  const token = header.replace(/^Bearer\s+/i, '').trim();
  if (!token) return undefined;
  try {
    return stringifyClaims(await getVerifier().verify(token));
  } catch {
    return undefined;
  }
}

function applyClaims(c: Parameters<MiddlewareHandler<AppEnv>>[0], claims: Record<string, string>): void {
  c.set('claims', claims);
  c.set('userId', claims.sub);
  if (claims.email) c.set('email', claims.email);
}

export function requireUser(): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const claims = await verifyBearer(c.req.header('authorization'));
    if (!claims?.sub) {
      return c.json(errorBody('UNAUTHORIZED', defaultsFor(401).message), 401, { 'www-authenticate': 'Bearer' });
    }
    applyClaims(c, claims);
    await next();
  };
}

/** Never rejects: sets the user only when a valid token is presented. */
export function optionalUser(): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const claims = await verifyBearer(c.req.header('authorization'));
    if (claims?.sub) applyClaims(c, claims);
    await next();
  };
}
