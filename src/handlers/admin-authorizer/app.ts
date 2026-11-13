import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';
import { verifyAdminToken } from '../../shared/admin-jwt';

const ssm = new SSMClient({});

const SECRET_TTL_MS = 15 * 60 * 1000;
let cachedJwtSecret: { value: string; at: number } | undefined;

async function getJwtSecret(): Promise<string> {
  if (cachedJwtSecret && Date.now() - cachedJwtSecret.at < SECRET_TTL_MS) return cachedJwtSecret.value;
  const paramName = process.env.ADMIN_JWT_SECRET_PARAM;
  if (!paramName) throw new Error('ADMIN_JWT_SECRET_PARAM not configured');
  const res = await ssm.send(new GetParameterCommand({
    Name: paramName,
    WithDecryption: true,
  }));
  const value = res.Parameter?.Value;
  if (!value) throw new Error('Admin JWT secret not found in SSM');
  cachedJwtSecret = { value, at: Date.now() };
  return value;
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
  } catch (err: any) {
    // A bad token never gets here (verifyAdminToken returns null); this is a missing parameter or an SSM outage,
    // which must reach the logs and answer 500, not look like "no permission".
    console.error(JSON.stringify({ msg: 'admin_authorizer_error', error: err?.message }));
    throw err;
  }
};
