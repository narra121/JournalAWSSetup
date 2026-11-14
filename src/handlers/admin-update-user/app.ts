import type { ApiHandler } from '../../shared/types';
import { CognitoIdentityProviderClient, AdminUpdateUserAttributesCommand } from '@aws-sdk/client-cognito-identity-provider';
import { UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { ddb } from '../../shared/dynamo';
import { envelope, errorResponse, ErrorCodes, errorFromException } from '../../shared/validation';
import { makeLogger } from '../../shared/logger';
import { resolveCognitoUsername } from '../../shared/cognitoUser';

const cognito = new CognitoIdentityProviderClient({});
const USER_POOL_ID = process.env.USER_POOL_ID!;

export const handler: ApiHandler = async (event) => {
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
      Username: await resolveCognitoUsername(USER_POOL_ID, userId),
      UserAttributes: attributes,
    }));

    // The copy GET /user/profile reads first (update-user-profile writes the same attribute).
    if (data.name !== undefined) {
      await ddb.send(new UpdateCommand({
        TableName: process.env.USER_PREFERENCES_TABLE!,
        Key: { userId },
        UpdateExpression: 'SET #name = :name, updatedAt = :now',
        ExpressionAttributeNames: { '#name': 'name' },
        ExpressionAttributeValues: { ':name': data.name, ':now': new Date().toISOString() },
      }));
    }

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
