import { APIGatewayProxyHandlerV2 } from 'aws-lambda';
import { CognitoIdentityProviderClient, ForgotPasswordCommand } from '@aws-sdk/client-cognito-identity-provider';
import { checkRateLimit } from '../auth-rate-limit-wrapper/rateLimit';

const client = new CognitoIdentityProviderClient({});
const CLIENT_ID = process.env.USER_POOL_CLIENT_ID!;

export const handler: APIGatewayProxyHandlerV2 = async (event) => {
  try {
    if (!event.body) return resp(400, null, { code: 'INVALID_REQUEST', message: 'Missing body' });
    const { email } = JSON.parse(event.body);
    if (!email) return resp(400, null, { code: 'INVALID_REQUEST', message: 'email required' });
    const rl = await checkRateLimit({ key: `forgot:${email}`, limit: 5, windowSeconds: 900 });
    if (!rl.allowed) return resp(429, null, { code: 'RATE_LIMIT_EXCEEDED', message: 'Too many attempts', details: { retryAfter: rl.retryAfter } });
    const cmd = new ForgotPasswordCommand({ ClientId: CLIENT_ID, Username: email });
    const r = await client.send(cmd);
    return resp(200, { codeDelivery: r.CodeDeliveryDetails }, null);
  } catch (e: any) { console.error(e); return resp(400, null, { code: 'FORGOT_PASSWORD_FAILED', message: e.message || 'Forgot password failed' }); }
};

function resp(statusCode: number, data: any, error: any) {
  return { statusCode, body: JSON.stringify({ data, error, meta: null }) };
}
