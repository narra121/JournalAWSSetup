import type { ApiHandler } from '../../shared/types';
import { CognitoIdentityProviderClient, AdminUpdateUserAttributesCommand } from '@aws-sdk/client-cognito-identity-provider';
import { UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { ddb } from '../../shared/dynamo';
import { errorResponse, envelope, ErrorCodes } from '../../shared/validation';
import { makeLogger } from '../../shared/logger';
import { getClaims, getUserId } from '../../shared/auth';
import { resolveCognitoUsername } from '../../shared/cognitoUser';

const USER_POOL_ID = process.env.USER_POOL_ID!;
const cognito = new CognitoIdentityProviderClient({});

export const handler: ApiHandler = async (event) => {
  const userId = getUserId(event);
  const log = makeLogger({ requestId: event.requestContext.requestId, userId });

  log.info('update-user-profile invoked');

  if (!userId) {
    log.warn('unauthorized request');
    return errorResponse(401, ErrorCodes.UNAUTHORIZED, 'Unauthorized');
  }

  if (!event.body) {
    log.warn('missing body');
    return errorResponse(400, ErrorCodes.VALIDATION_ERROR, 'Missing body');
  }

  let data: any;
  try {
    data = JSON.parse(event.body);
  } catch (e) {
    log.warn('invalid json', { error: (e as any)?.message });
    return errorResponse(400, ErrorCodes.VALIDATION_ERROR, 'Invalid JSON');
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) return errorResponse(400, ErrorCodes.VALIDATION_ERROR, 'Body must be a JSON object');

  // Only the name can change here: an e-mail change needs a code the pool sends and no endpoint confirms.
  if (data.name === undefined) {
    log.warn('no fields to update');
    return errorResponse(400, ErrorCodes.VALIDATION_ERROR, 'No fields to update');
  }
  if (typeof data.name !== 'string') {
    log.warn('invalid name type');
    return errorResponse(400, ErrorCodes.VALIDATION_ERROR, 'name must be a string');
  }
  if (!data.name.trim()) {
    log.warn('empty name');
    return errorResponse(400, ErrorCodes.VALIDATION_ERROR, 'name cannot be empty');
  }

  try {
    // Admin API with the Cognito username: a sub is accepted there only for local users.
    try {
      await cognito.send(new AdminUpdateUserAttributesCommand({
        UserPoolId: USER_POOL_ID,
        Username: await resolveCognitoUsername(USER_POOL_ID, userId, getClaims(event)),
        UserAttributes: [{ Name: 'name', Value: data.name }],
      }));
      log.info('cognito attributes updated');
    } catch (cognitoError: any) {
      log.warn('failed to update cognito', { error: cognitoError.message });
      return errorResponse(500, ErrorCodes.INTERNAL_ERROR, 'Failed to update profile attributes');
    }

    // GET /user/profile reads this copy: the caller's ID token carries the old name until it is reissued.
    await ddb.send(new UpdateCommand({
      TableName: process.env.USER_PREFERENCES_TABLE!,
      Key: { userId },
      UpdateExpression: 'SET #name = :name, updatedAt = :now',
      ExpressionAttributeNames: { '#name': 'name' },
      ExpressionAttributeValues: { ':name': data.name, ':now': new Date().toISOString() },
    }));

    log.info('profile updated');

    return envelope({ statusCode: 200, message: 'Profile updated successfully' });
  } catch (error: any) {
    log.error('failed to update user profile', { error: error.message });
    return errorResponse(500, ErrorCodes.INTERNAL_ERROR, 'Failed to update user profile');
  }
};

