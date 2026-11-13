import type { ApiHandler } from '../../shared/types';
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';
import { timingSafeEqual } from 'crypto';
import { checkRateLimit } from '../auth-rate-limit-wrapper/rateLimit';
import { signAdminToken } from '../../shared/admin-jwt';
import { envelope, errorResponse, ErrorCodes } from '../../shared/validation';
import { makeLogger } from '../../shared/logger';
import jwt from 'jsonwebtoken';

const ssm = new SSMClient({});
const ADMIN_SECRET_PARAM = process.env.ADMIN_SECRET_PARAM!;
const ADMIN_JWT_SECRET_PARAM = process.env.ADMIN_JWT_SECRET_PARAM!;

const SECRET_TTL_MS = 15 * 60 * 1000;
let cachedAdminSecret: { value: string; at: number } | undefined;
let cachedJwtSecret: { value: string; at: number } | undefined;

/** @internal Exposed for testing only */
export function _clearSecretCache(): void {
  cachedAdminSecret = undefined;
  cachedJwtSecret = undefined;
}

async function getAdminSecret(): Promise<string> {
  if (cachedAdminSecret && Date.now() - cachedAdminSecret.at < SECRET_TTL_MS) return cachedAdminSecret.value;
  const res = await ssm.send(new GetParameterCommand({
    Name: ADMIN_SECRET_PARAM,
    WithDecryption: true,
  }));
  const value = res.Parameter?.Value;
  if (!value) throw new Error('Admin secret not found in SSM');
  cachedAdminSecret = { value, at: Date.now() };
  return value;
}

async function getJwtSecret(): Promise<string> {
  if (cachedJwtSecret && Date.now() - cachedJwtSecret.at < SECRET_TTL_MS) return cachedJwtSecret.value;
  const res = await ssm.send(new GetParameterCommand({
    Name: ADMIN_JWT_SECRET_PARAM,
    WithDecryption: true,
  }));
  const value = res.Parameter?.Value;
  if (!value) throw new Error('Admin JWT secret not found in SSM');
  cachedJwtSecret = { value, at: Date.now() };
  return value;
}

function constantTimeCompare(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) {
    // Compare against self to burn same CPU time, then return false
    timingSafeEqual(bufA, bufA);
    return false;
  }
  return timingSafeEqual(bufA, bufB);
}

export const handler: ApiHandler = async (event) => {
  const log = makeLogger({ requestId: event.requestContext?.requestId });
  try {
    if (!event.body) return errorResponse(400, ErrorCodes.VALIDATION_ERROR, 'Missing body');

    let parsed: any;
    try { parsed = JSON.parse(event.body); } catch { return errorResponse(400, ErrorCodes.VALIDATION_ERROR, 'Invalid JSON'); }
    const password = parsed?.password;
    if (typeof password !== 'string' || !password) return errorResponse(400, ErrorCodes.VALIDATION_ERROR, 'password is required');

    // Per source IP: one address cannot lock the real admin out and gets only 5 tries per 5 minutes.
    const sourceIp = event.requestContext?.http?.sourceIp || 'unknown';
    const rl = await checkRateLimit({ key: `admin-login:${sourceIp}`, limit: 5, windowSeconds: 300 });
    if (!rl.allowed) return errorResponse(429, ErrorCodes.RATE_LIMITED, 'Too many attempts', { retryAfter: rl.retryAfter });

    // Across all addresses: a guesser rotating IPs still gets at most 50 tries an hour (and can block the admin for that hour).
    const global = await checkRateLimit({ key: 'admin-login:global', limit: 50, windowSeconds: 3600 });
    if (!global.allowed) {
      log.warn('Admin login blocked: global attempt limit reached');
      return errorResponse(429, ErrorCodes.RATE_LIMITED, 'Too many attempts', { retryAfter: global.retryAfter });
    }

    const [adminSecret, jwtSecret] = await Promise.all([
      getAdminSecret(),
      getJwtSecret(),
    ]);

    if (!constantTimeCompare(password, adminSecret)) {
      log.warn('Admin login failed: wrong password');
      return errorResponse(401, ErrorCodes.UNAUTHORIZED, 'Invalid credentials');
    }

    const token = signAdminToken(jwtSecret);
    const decoded = jwt.decode(token) as { exp: number };

    log.info('Admin login successful');
    return envelope({
      statusCode: 200,
      data: { token, expiresAt: decoded.exp },
      message: 'Admin login successful',
    });
  } catch (e: any) {
    log.error('Admin login error', { error: e.message });
    return errorResponse(500, ErrorCodes.INTERNAL_ERROR, 'Internal error');
  }
};
