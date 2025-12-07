import { APIGatewayProxyHandlerV2 } from 'aws-lambda';
import { CognitoIdentityProviderClient, ConfirmSignUpCommand } from '@aws-sdk/client-cognito-identity-provider';
const client = new CognitoIdentityProviderClient({});
const CLIENT_ID = process.env.USER_POOL_CLIENT_ID!;

export const handler: APIGatewayProxyHandlerV2 = async (event) => {
  try {
    if (!event.body) return resp(400, null, { code: 'INVALID_REQUEST', message: 'Missing body' });
    const { email, code } = JSON.parse(event.body);
    if (!email || !code) return resp(400, null, { code: 'INVALID_REQUEST', message: 'email and code required' });
    await client.send(new ConfirmSignUpCommand({ ClientId: CLIENT_ID, Username: email, ConfirmationCode: code }));
    return resp(200, { confirmed: true }, null);
  } catch (e: any) { console.error(e); return resp(400, null, { code: 'CONFIRM_FAILED', message: e.message || 'Confirm failed' }); }
};

function resp(statusCode: number, data: any, error: any) {
  return { statusCode, body: JSON.stringify({ data, error, meta: null }) };
}
