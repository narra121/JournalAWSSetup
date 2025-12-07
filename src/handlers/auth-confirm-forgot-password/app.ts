import { APIGatewayProxyHandlerV2 } from 'aws-lambda';
import { CognitoIdentityProviderClient, ConfirmForgotPasswordCommand } from '@aws-sdk/client-cognito-identity-provider';
import { checkRateLimit } from '../auth-rate-limit-wrapper/rateLimit';

const client = new CognitoIdentityProviderClient({});
const CLIENT_ID = process.env.USER_POOL_CLIENT_ID!;

export const handler: APIGatewayProxyHandlerV2 = async (event) => {
  try {
    if (!event.body) return resp(400, null, { code: 'INVALID_REQUEST', message: 'Missing body' });
    const { email, code, newPassword } = JSON.parse(event.body);
    if (!email || !code || !newPassword) return resp(400, null, { code: 'INVALID_REQUEST', message: 'email, code, newPassword required' });
  if (newPassword.length < 6 || newPassword.length > 18) return resp(400, null, { code: 'INVALID_REQUEST', message: 'newPassword must be 6-18 characters' });
    const rl = await checkRateLimit({ key: `forgot-confirm:${email}`, limit: 10, windowSeconds: 900 });
    if (!rl.allowed) return resp(429, null, { code: 'RATE_LIMIT_EXCEEDED', message: 'Too many attempts', details: { retryAfter: rl.retryAfter } });
    const cmd = new ConfirmForgotPasswordCommand({ ClientId: CLIENT_ID, Username: email, ConfirmationCode: code, Password: newPassword });
    await client.send(cmd);
    return resp(200, { message: 'Password reset confirmed' }, null);
  } catch (e: any) { console.error(e); return resp(400, null, { code: 'CONFIRM_FORGOT_FAILED', message: e.message || 'Confirm forgot password failed' }); }
};

function resp(statusCode: number, data: any, error: any) {
  return { statusCode, body: JSON.stringify({ data, error, meta: null }) };
}
