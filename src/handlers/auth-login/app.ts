import { APIGatewayProxyHandlerV2 } from 'aws-lambda';
import { CognitoIdentityProviderClient, InitiateAuthCommand } from '@aws-sdk/client-cognito-identity-provider';
import { checkRateLimit } from '../auth-rate-limit-wrapper/rateLimit';

const client = new CognitoIdentityProviderClient({});
const CLIENT_ID = process.env.USER_POOL_CLIENT_ID!;

export const handler: APIGatewayProxyHandlerV2 = async (event) => {
  try {
    if (!event.body) return resp(400, { message: 'Missing body' });
    const { email, password } = JSON.parse(event.body);
    if (!email || !password) return resp(400, { message: 'email and password required' });
    const rl = await checkRateLimit({ key: `login:${email}`, limit: 10, windowSeconds: 300 });
    if (!rl.allowed) return resp(429, { message: 'Too many attempts', retryAfter: rl.retryAfter });
    const cmd = new InitiateAuthCommand({
      AuthFlow: 'USER_PASSWORD_AUTH',
      ClientId: CLIENT_ID,
      AuthParameters: { USERNAME: email, PASSWORD: password }
    });
    const r = await client.send(cmd);
    if (!r.AuthenticationResult) return resp(400, { message: 'Authentication failed' });
    const { IdToken, AccessToken, RefreshToken, ExpiresIn, TokenType } = r.AuthenticationResult;
    return resp(200, { IdToken, AccessToken, RefreshToken, ExpiresIn, TokenType });
  } catch (e: any) { console.error(e); return resp(400, { message: e.message || 'Login failed' }); }
};

function resp(statusCode: number, body: any) { return { statusCode, body: JSON.stringify(body) }; }
