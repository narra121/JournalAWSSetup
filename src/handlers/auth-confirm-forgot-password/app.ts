import type { ApiHandler } from '../../shared/types';
import { CognitoIdentityProviderClient, ConfirmForgotPasswordCommand } from '@aws-sdk/client-cognito-identity-provider';
import { checkRateLimit } from '../auth-rate-limit-wrapper/rateLimit';
import { envelope, errorResponse, ErrorCodes } from '../../shared/validation';
import { cognitoFailure } from '../../shared/cognitoErrors';
import { validatePassword } from '../../shared/passwordValidation';

const client = new CognitoIdentityProviderClient({});
const CLIENT_ID = process.env.USER_POOL_CLIENT_ID!;

export const handler: ApiHandler = async (event) => {
  try {
    if (!event.body) return errorResponse(400, ErrorCodes.VALIDATION_ERROR, 'Missing body');
    const { email, code, newPassword } = JSON.parse(event.body);
    if (!email || !code || !newPassword) return errorResponse(400, ErrorCodes.VALIDATION_ERROR, 'email, code, newPassword required');
    const pwError = validatePassword(newPassword);
    if (pwError) return errorResponse(400, ErrorCodes.VALIDATION_ERROR, pwError);
    const rl = await checkRateLimit({ key: `forgot-confirm:${email}`, limit: 10, windowSeconds: 900 });
    if (!rl.allowed) return errorResponse(429, ErrorCodes.RATE_LIMITED, 'Too many attempts', { retryAfter: rl.retryAfter });
    const cmd = new ConfirmForgotPasswordCommand({ ClientId: CLIENT_ID, Username: email, ConfirmationCode: code, Password: newPassword });
    await client.send(cmd);
    return envelope({ statusCode: 200, data: { message: 'Password reset confirmed' }, message: 'Password reset successfully' });
  } catch (e: any) { console.error(e); return cognitoFailure(e, 'confirm-forgot-password'); }
};
