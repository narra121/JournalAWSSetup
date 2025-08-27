import { APIGatewayProxyHandlerV2 } from 'aws-lambda';
import { CognitoIdentityProviderClient, SignUpCommand } from '@aws-sdk/client-cognito-identity-provider';
import { checkRateLimit } from '../auth-rate-limit-wrapper/rateLimit';

const client = new CognitoIdentityProviderClient({});
const CLIENT_ID = process.env.USER_POOL_CLIENT_ID!;

export const handler: APIGatewayProxyHandlerV2 = async (event) => {
  try {
    // Basic request logging (omit password contents for security)
    try {
      if (event.body) {
        const tmp = JSON.parse(event.body);
        console.log('Signup attempt', { email: tmp.email });
      } else {
        console.log('Signup attempt with empty body');
      }
    } catch (e) {
      console.log('Failed to parse body for logging');
    }
    if (!event.body) return resp(400, { message: 'Missing body' });
    const { email, password } = JSON.parse(event.body);
    if (!email || !password) return resp(400, { message: 'email and password required' });
  if (password.length < 6 || password.length > 18) return resp(400, { message: 'password must be 6-18 characters' });
    const rl = await checkRateLimit({ key: `signup:${email}`, limit: 5, windowSeconds: 3600 });
    if (!rl.allowed) return resp(429, { message: 'Too many attempts', retryAfter: rl.retryAfter });
    const cmd = new SignUpCommand({ ClientId: CLIENT_ID, Username: email, Password: password, UserAttributes: [{ Name: 'email', Value: email }] });
    const r = await client.send(cmd);
    return resp(200, { userConfirmed: r.UserConfirmed, codeDelivery: r.CodeDeliveryDetails });
  } catch (e: any) {
    console.error('Signup error:', { name: e?.name, message: e?.message, stack: e?.stack });
    return resp(400, { message: e?.message || 'Signup failed', code: e?.name || 'Error' });
  }
};

function resp(statusCode: number, body: any) { return { statusCode, body: JSON.stringify(body) }; }
