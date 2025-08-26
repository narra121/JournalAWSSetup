import { APIGatewayProxyHandlerV2 } from 'aws-lambda';
import { CognitoIdentityProviderClient, ConfirmForgotPasswordCommand } from '@aws-sdk/client-cognito-identity-provider';
import { checkRateLimit } from '../auth-rate-limit-wrapper/rateLimit';

const client = new CognitoIdentityProviderClient({});
const CLIENT_ID = process.env.USER_POOL_CLIENT_ID!;

export const handler: APIGatewayProxyHandlerV2 = async (event) => {
  try {
    if (!event.body) return resp(400, { message: 'Missing body' });
    const { email, code, newPassword } = JSON.parse(event.body);
    if (!email || !code || !newPassword) return resp(400, { message: 'email, code, newPassword required' });
  if (newPassword.length < 6 || newPassword.length > 18) return resp(400, { message: 'newPassword must be 6-18 characters' });
    const rl = await checkRateLimit({ key: `forgot-confirm:${email}`, limit: 10, windowSeconds: 900 });
    if (!rl.allowed) return resp(429, { message: 'Too many attempts', retryAfter: rl.retryAfter });
    const cmd = new ConfirmForgotPasswordCommand({ ClientId: CLIENT_ID, Username: email, ConfirmationCode: code, Password: newPassword });
    await client.send(cmd);
    return resp(200, { message: 'Password reset confirmed' });
  } catch (e: any) { console.error(e); return resp(400, { message: e.message || 'Confirm forgot password failed' }); }
};

function resp(statusCode: number, body: any) { return { statusCode, body: JSON.stringify(body) }; }
