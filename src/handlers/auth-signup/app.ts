import { APIGatewayProxyHandlerV2 } from 'aws-lambda';
import { CognitoIdentityProviderClient, SignUpCommand, ResendConfirmationCodeCommand } from '@aws-sdk/client-cognito-identity-provider';
import { checkRateLimit } from '../auth-rate-limit-wrapper/rateLimit';
import { envelope, errorResponse, ErrorCodes } from '../../shared/validation';

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
    if (!event.body) return errorResponse(400, ErrorCodes.VALIDATION_ERROR, 'Missing body');
    const { email, password, name } = JSON.parse(event.body);
    if (!email || !password || !name) return errorResponse(400, ErrorCodes.VALIDATION_ERROR, 'email, name, and password required');
  if (password.length < 8 || password.length > 128) return errorResponse(400, ErrorCodes.VALIDATION_ERROR, 'Password must be 8-128 characters');
    const rl = await checkRateLimit({ key: `signup:${email}`, limit: 5, windowSeconds: 3600 });
    if (!rl.allowed) return errorResponse(429, ErrorCodes.INTERNAL_ERROR, 'Too many attempts', { retryAfter: rl.retryAfter });
    const cmd = new SignUpCommand({ ClientId: CLIENT_ID, Username: email, Password: password, UserAttributes: [{ Name: 'email', Value: email }, { Name: 'name', Value: name }] });
    const r = await client.send(cmd);
    return envelope({ statusCode: 200, data: { user: { id: r.UserSub, name, email } }, message: 'User created. Please check your email for a confirmation code.' });
  } catch (e: any) {
    console.error('Signup error', { name: e?.name, message: e?.message, stack: e?.stack });
    
    // If user already exists but is not confirmed, resend the confirmation code
    if (e.name === 'UsernameExistsException') {
      try {
        const { email } = JSON.parse(event.body!);
        await client.send(new ResendConfirmationCodeCommand({ ClientId: CLIENT_ID, Username: email }));
        return envelope({ 
          statusCode: 200, 
          data: { user: { email }, resent: true }, 
          message: 'Account exists but not verified. Verification code resent to your email.' 
        });
      } catch (resendError: any) {
        console.error('Failed to resend confirmation code', { error: resendError.message });
        // If resend fails, return the original error
        return errorResponse(400, ErrorCodes.USER_EXISTS, 'An account with this email already exists. Please login or reset your password.');
      }
    }
    
    return errorResponse(400, ErrorCodes.VALIDATION_ERROR, e?.message || 'Signup failed');
  }
};
