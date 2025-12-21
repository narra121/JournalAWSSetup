import { APIGatewayProxyHandlerV2 } from 'aws-lambda';
import { CognitoIdentityProviderClient, AdminUserGlobalSignOutCommand } from '@aws-sdk/client-cognito-identity-provider';
import { envelope, errorResponse, ErrorCodes } from '../../shared/validation';

const USER_POOL_ID = process.env.USER_POOL_ID!;
const client = new CognitoIdentityProviderClient({});

export const handler: APIGatewayProxyHandlerV2 = async (event) => {
  const rc: any = event.requestContext as any;
  const email = rc?.authorizer?.jwt?.claims?.email; // username
  if (!email) return errorResponse(401, ErrorCodes.UNAUTHORIZED, 'Unauthorized');
  try {
    await client.send(new AdminUserGlobalSignOutCommand({ UserPoolId: USER_POOL_ID, Username: email }));
    return envelope({ statusCode: 200, data: { message: 'Global sign-out initiated' }, message: 'Logged out from all devices' });
  } catch (e: any) { console.error(e); return errorResponse(500, ErrorCodes.INTERNAL_ERROR, e.message || 'Failed global sign-out'); }
};
