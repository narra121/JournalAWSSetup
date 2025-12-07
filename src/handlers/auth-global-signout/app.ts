import { APIGatewayProxyHandlerV2 } from 'aws-lambda';
import { CognitoIdentityProviderClient, AdminUserGlobalSignOutCommand } from '@aws-sdk/client-cognito-identity-provider';

const USER_POOL_ID = process.env.USER_POOL_ID!;
const client = new CognitoIdentityProviderClient({});

export const handler: APIGatewayProxyHandlerV2 = async (event) => {
  const rc: any = event.requestContext as any;
  const email = rc?.authorizer?.jwt?.claims?.email; // username
  if (!email) return resp(401, null, { code: 'UNAUTHORIZED', message: 'Unauthorized' });
  try {
    await client.send(new AdminUserGlobalSignOutCommand({ UserPoolId: USER_POOL_ID, Username: email }));
    return resp(200, { message: 'Global sign-out initiated' }, null);
  } catch (e: any) { console.error(e); return resp(500, null, { code: 'SIGNOUT_FAILED', message: e.message || 'Failed global sign-out' }); }
};

function resp(statusCode: number, data: any, error: any) {
  return { statusCode, body: JSON.stringify({ data, error, meta: null }) };
}
