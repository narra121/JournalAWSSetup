import { APIGatewayProxyHandlerV2 } from 'aws-lambda';
import { CognitoIdentityProviderClient, AdminUpdateUserAttributesCommand } from '@aws-sdk/client-cognito-identity-provider';
import { envelope, errorResponse, ErrorCodes, errorFromException } from '../../shared/validation';
import { makeLogger } from '../../shared/logger';

const cognito = new CognitoIdentityProviderClient({});
const USER_POOL_ID = process.env.USER_POOL_ID!;

export const handler: APIGatewayProxyHandlerV2 = async (event) => {
  const log = makeLogger({ requestId: event.requestContext?.requestId });

  try {
    const userId = event.pathParameters?.userId;
    if (!userId) {
      return errorResponse(400, ErrorCodes.VALIDATION_ERROR, 'userId path parameter is required');
    }

    if (!event.body) {
      return errorResponse(400, ErrorCodes.VALIDATION_ERROR, 'Missing body');
    }

    let data: any;
    try {
      data = JSON.parse(event.body);
    } catch (e) {
      return errorResponse(400, ErrorCodes.VALIDATION_ERROR, 'Invalid JSON');
    }

    const attributes: { Name: string; Value: string }[] = [];
    if (data.name !== undefined) {
      if (typeof data.name !== 'string') {
        return errorResponse(400, ErrorCodes.VALIDATION_ERROR, 'name must be a string');
      }
      attributes.push({ Name: 'name', Value: data.name });
    }

    if (attributes.length === 0) {
      return errorResponse(400, ErrorCodes.VALIDATION_ERROR, 'No fields to update');
    }

    log.info('admin-update-user', { userId, attributeCount: attributes.length });

    await cognito.send(new AdminUpdateUserAttributesCommand({
      UserPoolId: USER_POOL_ID,
      Username: userId,
      UserAttributes: attributes,
    }));

    log.info('admin-update-user success', { userId });

    return envelope({
      statusCode: 200,
      data: { userId, updated: attributes.map(a => a.Name) },
      message: 'User updated successfully',
    });
  } catch (err: any) {
    log.error('admin-update-user failed', { error: err.message });
    return errorFromException(err, true);
  }
};
