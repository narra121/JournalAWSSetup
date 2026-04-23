import { APIGatewayProxyHandlerV2 } from 'aws-lambda';
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

let cachedAdminSecret: string | undefined;
let cachedJwtSecret: string | undefined;

async function getAdminSecret(): Promise<string> {
  if (cachedAdminSecret) return cachedAdminSecret;
  const res = await ssm.send(new GetParameterCommand({
    Name: ADMIN_SECRET_PARAM,
    WithDecryption: true,
  }));
  cachedAdminSecret = res.Parameter?.Value;
  if (!cachedAdminSecret) throw new Error('Admin secret not found in SSM');
  return cachedAdminSecret;
}

async function getJwtSecret(): Promise<string> {
  if (cachedJwtSecret) return cachedJwtSecret;
  const res = await ssm.send(new GetParameterCommand({
    Name: ADMIN_JWT_SECRET_PARAM,
    WithDecryption: true,
  }));
  cachedJwtSecret = res.Parameter?.Value;
  if (!cachedJwtSecret) throw new Error('Admin JWT secret not found in SSM');
  return cachedJwtSecret;
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

export const handler: APIGatewayProxyHandlerV2 = async (event) => {
  const log = makeLogger({ requestId: event.requestContext?.requestId });
  try {
    if (!event.body) return errorResponse(400, ErrorCodes.VALIDATION_ERROR, 'Missing body');

    const { password } = JSON.parse(event.body);
    if (!password) return errorResponse(400, ErrorCodes.VALIDATION_ERROR, 'password is required');

    const rl = await checkRateLimit({ key: 'admin-login', limit: 5, windowSeconds: 300 });
    if (!rl.allowed) return errorResponse(429, ErrorCodes.RATE_LIMITED, 'Too many attempts', { retryAfter: rl.retryAfter });

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
