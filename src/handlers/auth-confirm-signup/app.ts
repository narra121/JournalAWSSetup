import { APIGatewayProxyHandlerV2 } from 'aws-lambda';
import { CognitoIdentityProviderClient, ConfirmSignUpCommand } from '@aws-sdk/client-cognito-identity-provider';
const client = new CognitoIdentityProviderClient({});
const CLIENT_ID = process.env.USER_POOL_CLIENT_ID!;

export const handler: APIGatewayProxyHandlerV2 = async (event) => {
  try {
    if (!event.body) return resp(400, { message: 'Missing body' });
    const { email, code } = JSON.parse(event.body);
    if (!email || !code) return resp(400, { message: 'email and code required' });
    await client.send(new ConfirmSignUpCommand({ ClientId: CLIENT_ID, Username: email, ConfirmationCode: code }));
    return resp(200, { confirmed: true });
  } catch (e: any) { console.error(e); return resp(400, { message: e.message || 'Confirm failed' }); }
};

function resp(statusCode: number, body: any) { return { statusCode, body: JSON.stringify(body) }; }
