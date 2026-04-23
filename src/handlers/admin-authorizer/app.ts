import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';
import { verifyAdminToken } from '../../shared/admin-jwt';

const ssm = new SSMClient({});

let cachedJwtSecret: string | undefined;

async function getJwtSecret(): Promise<string> {
  if (cachedJwtSecret) return cachedJwtSecret;
  const paramName = process.env.ADMIN_JWT_SECRET_PARAM;
  if (!paramName) throw new Error('ADMIN_JWT_SECRET_PARAM not configured');
  const res = await ssm.send(new GetParameterCommand({
    Name: paramName,
    WithDecryption: true,
  }));
  cachedJwtSecret = res.Parameter?.Value;
  if (!cachedJwtSecret) throw new Error('Admin JWT secret not found in SSM');
  return cachedJwtSecret;
}

/** @internal Exposed for testing only */
export function _clearSecretCache(): void {
  cachedJwtSecret = undefined;
}

interface AuthorizerEvent {
  headers?: Record<string, string | undefined>;
  [key: string]: unknown;
}

interface AuthorizerResponse {
  isAuthorized: boolean;
}

export const handler = async (event: AuthorizerEvent): Promise<AuthorizerResponse> => {
  try {
    const authHeader = event.headers?.authorization || event.headers?.Authorization;
    if (!authHeader) return { isAuthorized: false };

    const match = authHeader.match(/^Bearer\s+(.+)$/i);
    if (!match) return { isAuthorized: false };

    const token = match[1];
    const secret = await getJwtSecret();
    const payload = verifyAdminToken(token, secret);

    return { isAuthorized: payload !== null };
  } catch {
    return { isAuthorized: false };
  }
};
