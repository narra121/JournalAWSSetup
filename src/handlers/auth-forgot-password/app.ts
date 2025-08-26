import { APIGatewayProxyHandlerV2 } from 'aws-lambda';
import { CognitoIdentityProviderClient, ForgotPasswordCommand } from '@aws-sdk/client-cognito-identity-provider';
import { checkRateLimit } from '../auth-rate-limit-wrapper/rateLimit';

const client = new CognitoIdentityProviderClient({});
const CLIENT_ID = process.env.USER_POOL_CLIENT_ID!;

export const handler: APIGatewayProxyHandlerV2 = async (event) => {
  try {
    if (!event.body) return resp(400, { message: 'Missing body' });
    const { email } = JSON.parse(event.body);
    if (!email) return resp(400, { message: 'email required' });
    const rl = await checkRateLimit({ key: `forgot:${email}`, limit: 5, windowSeconds: 900 });
    if (!rl.allowed) return resp(429, { message: 'Too many attempts', retryAfter: rl.retryAfter });
    const cmd = new ForgotPasswordCommand({ ClientId: CLIENT_ID, Username: email });
    const r = await client.send(cmd);
    return resp(200, { codeDelivery: r.CodeDeliveryDetails });
  } catch (e: any) { console.error(e); return resp(400, { message: e.message || 'Forgot password failed' }); }
};

function resp(statusCode: number, body: any) { return { statusCode, body: JSON.stringify(body) }; }
