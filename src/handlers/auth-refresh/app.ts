import { APIGatewayProxyHandlerV2 } from 'aws-lambda';
import { CognitoIdentityProviderClient, InitiateAuthCommand } from '@aws-sdk/client-cognito-identity-provider';
import { envelope, errorResponse, ErrorCodes } from '../../shared/validation';

const client = new CognitoIdentityProviderClient({});
const CLIENT_ID = process.env.USER_POOL_CLIENT_ID!;

export const handler: APIGatewayProxyHandlerV2 = async (event) => {
  try {
    if (!event.body) return errorResponse(400, ErrorCodes.VALIDATION_ERROR, 'Missing body');
    const { refreshToken } = JSON.parse(event.body);
    if (!refreshToken) return errorResponse(400, ErrorCodes.VALIDATION_ERROR, 'refreshToken required');
    const cmd = new InitiateAuthCommand({
      AuthFlow: 'REFRESH_TOKEN_AUTH',
      ClientId: CLIENT_ID,
      AuthParameters: { REFRESH_TOKEN: refreshToken }
    });
    const r = await client.send(cmd);
    if (!r.AuthenticationResult) return errorResponse(400, ErrorCodes.UNAUTHORIZED, 'Refresh failed');
    const { IdToken, AccessToken, ExpiresIn, TokenType } = r.AuthenticationResult;
    return envelope({ statusCode: 200, data: { IdToken, AccessToken, ExpiresIn, TokenType }, message: 'Token refreshed' });
  } catch (e: any) { console.error(e); return errorResponse(400, ErrorCodes.UNAUTHORIZED, e.message || 'Refresh failed'); }
};
