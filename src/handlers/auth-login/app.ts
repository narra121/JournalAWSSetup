import { APIGatewayProxyHandlerV2 } from 'aws-lambda';
import { CognitoIdentityProviderClient, InitiateAuthCommand } from '@aws-sdk/client-cognito-identity-provider';
import { checkRateLimit } from '../auth-rate-limit-wrapper/rateLimit';

const client = new CognitoIdentityProviderClient({});
const CLIENT_ID = process.env.USER_POOL_CLIENT_ID!;

export const handler: APIGatewayProxyHandlerV2 = async (event) => {
  try {
    if (!event.body) return resp(400, null, { code: 'INVALID_REQUEST', message: 'Missing body' });
    const { email, password } = JSON.parse(event.body);
    if (!email || !password) return resp(400, null, { code: 'INVALID_REQUEST', message: 'email and password required' });
    const rl = await checkRateLimit({ key: `login:${email}`, limit: 10, windowSeconds: 300 });
    if (!rl.allowed) return resp(429, null, { code: 'RATE_LIMIT_EXCEEDED', message: 'Too many attempts', details: { retryAfter: rl.retryAfter } });
    const cmd = new InitiateAuthCommand({
      AuthFlow: 'USER_PASSWORD_AUTH',
      ClientId: CLIENT_ID,
      AuthParameters: { USERNAME: email, PASSWORD: password }
    });
    const r = await client.send(cmd);
    if (!r.AuthenticationResult) return resp(400, null, { code: 'AUTH_FAILED', message: 'Authentication failed' });
    const { IdToken, AccessToken, RefreshToken, ExpiresIn, TokenType } = r.AuthenticationResult;
    return resp(200, { IdToken, AccessToken, RefreshToken, ExpiresIn, TokenType }, null);
  } catch (e: any) { console.error(e); return resp(400, null, { code: 'LOGIN_FAILED', message: e.message || 'Login failed' }); }
};

function resp(statusCode: number, data: any, error: any) {
  return { statusCode, body: JSON.stringify({ data, error, meta: null }) };
}
