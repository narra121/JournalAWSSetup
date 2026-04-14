import { APIGatewayProxyHandlerV2 } from 'aws-lambda';
import { CognitoIdentityProviderClient, ConfirmSignUpCommand } from '@aws-sdk/client-cognito-identity-provider';
import { envelope, errorResponse, ErrorCodes } from '../../shared/validation';

const client = new CognitoIdentityProviderClient({});
const CLIENT_ID = process.env.USER_POOL_CLIENT_ID!;

export const handler: APIGatewayProxyHandlerV2 = async (event) => {
  try {
    if (!event.body) return errorResponse(400, ErrorCodes.VALIDATION_ERROR, 'Missing body');
    const { email, code } = JSON.parse(event.body);
    if (!email || !code) return errorResponse(400, ErrorCodes.VALIDATION_ERROR, 'email and code required');

    await client.send(new ConfirmSignUpCommand({ ClientId: CLIENT_ID, Username: email, ConfirmationCode: code }));

    return envelope({ statusCode: 200, data: { confirmed: true }, message: 'Email verified successfully' });
  } catch (e: any) { console.error(e); return errorResponse(400, ErrorCodes.VALIDATION_ERROR, e.message || 'Confirm failed'); }
};
