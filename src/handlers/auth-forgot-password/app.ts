import { APIGatewayProxyHandlerV2 } from 'aws-lambda';
import { CognitoIdentityProviderClient, ForgotPasswordCommand } from '@aws-sdk/client-cognito-identity-provider';
import { checkRateLimit } from '../auth-rate-limit-wrapper/rateLimit';
import { envelope, errorResponse, ErrorCodes } from '../../shared/validation';

const client = new CognitoIdentityProviderClient({});
const CLIENT_ID = process.env.USER_POOL_CLIENT_ID!;

export const handler: APIGatewayProxyHandlerV2 = async (event) => {
  try {
    if (!event.body) return errorResponse(400, ErrorCodes.VALIDATION_ERROR, 'Missing body');
    const { email } = JSON.parse(event.body);
    if (!email) return errorResponse(400, ErrorCodes.VALIDATION_ERROR, 'email required');
    const rl = await checkRateLimit({ key: `forgot:${email}`, limit: 5, windowSeconds: 900 });
    if (!rl.allowed) return errorResponse(429, ErrorCodes.INTERNAL_ERROR, 'Too many attempts', { retryAfter: rl.retryAfter });
    const cmd = new ForgotPasswordCommand({ ClientId: CLIENT_ID, Username: email });
    const r = await client.send(cmd);
    return envelope({ statusCode: 200, data: { message: `Password reset code sent to ${r.CodeDeliveryDetails?.Destination}.` }, message: 'Reset code sent' });
  } catch (e: any) { console.error(e); return errorResponse(400, ErrorCodes.INTERNAL_ERROR, e.message || 'Forgot password failed'); }
};
