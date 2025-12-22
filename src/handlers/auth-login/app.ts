import { APIGatewayProxyHandlerV2 } from 'aws-lambda';
import { CognitoIdentityProviderClient, InitiateAuthCommand, GetUserCommand } from '@aws-sdk/client-cognito-identity-provider';
import { checkRateLimit } from '../auth-rate-limit-wrapper/rateLimit';
import { envelope, errorResponse, ErrorCodes } from '../../shared/validation';

const client = new CognitoIdentityProviderClient({});
const CLIENT_ID = process.env.USER_POOL_CLIENT_ID!;

export const handler: APIGatewayProxyHandlerV2 = async (event) => {
  try {
    if (!event.body) return errorResponse(400, ErrorCodes.VALIDATION_ERROR, 'Missing body');
    const { email, password } = JSON.parse(event.body);
    if (!email || !password) return errorResponse(400, ErrorCodes.VALIDATION_ERROR, 'email and password required');
    const rl = await checkRateLimit({ key: `login:${email}`, limit: 10, windowSeconds: 300 });
    if (!rl.allowed) return errorResponse(429, ErrorCodes.INTERNAL_ERROR, 'Too many attempts', { retryAfter: rl.retryAfter });
    const cmd = new InitiateAuthCommand({
      AuthFlow: 'USER_PASSWORD_AUTH',
      ClientId: CLIENT_ID,
      AuthParameters: { USERNAME: email, PASSWORD: password }
    });
    const r = await client.send(cmd);
    if (!r.AuthenticationResult) return errorResponse(400, ErrorCodes.UNAUTHORIZED, 'Authentication failed');
    const { IdToken, AccessToken, RefreshToken, ExpiresIn, TokenType } = r.AuthenticationResult;

    const userCmd = new GetUserCommand({ AccessToken: AccessToken! });
    const userRes = await client.send(userCmd);

    const user = {
      id: userRes.UserAttributes?.find(a => a.Name === 'sub')?.Value,
      name: userRes.UserAttributes?.find(a => a.Name === 'name')?.Value,
      email: userRes.UserAttributes?.find(a => a.Name === 'email')?.Value,
    };

    return envelope({ statusCode: 200, data: { IdToken, AccessToken, RefreshToken, ExpiresIn, TokenType, user }, message: 'Login successful' });
  } catch (e: any) { 
    console.error(e);
    
    // Check if the user's email is not verified
    if (e.name === 'UserNotConfirmedException') {
      return errorResponse(403, ErrorCodes.EMAIL_NOT_VERIFIED, 'Please verify your email before logging in. Check your inbox for the verification code.');
    }
    
    return errorResponse(400, ErrorCodes.UNAUTHORIZED, e.message || 'Login failed'); 
  }
};
