import { APIGatewayProxyHandlerV2 } from 'aws-lambda';
import { CognitoIdentityProviderClient, InitiateAuthCommand } from '@aws-sdk/client-cognito-identity-provider';
const client = new CognitoIdentityProviderClient({});
const CLIENT_ID = process.env.USER_POOL_CLIENT_ID!;

export const handler: APIGatewayProxyHandlerV2 = async (event) => {
  try {
    if (!event.body) return resp(400, { message: 'Missing body' });
    const { refreshToken } = JSON.parse(event.body);
    if (!refreshToken) return resp(400, { message: 'refreshToken required' });
    const cmd = new InitiateAuthCommand({
      AuthFlow: 'REFRESH_TOKEN_AUTH',
      ClientId: CLIENT_ID,
      AuthParameters: { REFRESH_TOKEN: refreshToken }
    });
    const r = await client.send(cmd);
    if (!r.AuthenticationResult) return resp(400, { message: 'Refresh failed' });
    const { IdToken, AccessToken, ExpiresIn, TokenType } = r.AuthenticationResult;
    return resp(200, { IdToken, AccessToken, ExpiresIn, TokenType });
  } catch (e: any) { console.error(e); return resp(400, { message: e.message || 'Refresh failed' }); }
};

function resp(statusCode: number, body: any) { return { statusCode, body: JSON.stringify(body) }; }
