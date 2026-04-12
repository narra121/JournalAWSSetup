import { APIGatewayProxyHandlerV2 } from 'aws-lambda';
import { CognitoIdentityProviderClient, AdminUpdateUserAttributesCommand } from '@aws-sdk/client-cognito-identity-provider';
import { errorResponse, envelope, ErrorCodes } from '../../shared/validation';
import { makeLogger } from '../../shared/logger';
import { getUserId } from '../../shared/auth';

const USER_POOL_ID = process.env.USER_POOL_ID!;
const cognito = new CognitoIdentityProviderClient({});

export const handler: APIGatewayProxyHandlerV2 = async (event) => {
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

  try {
    // Update Cognito user attributes using Admin API (works with userId/sub, no access token needed)
    if (data.name || data.email) {
      const attributes = [];
      if (data.name) attributes.push({ Name: 'name', Value: data.name });
      if (data.email) attributes.push({ Name: 'email', Value: data.email });

      try {
        await cognito.send(new AdminUpdateUserAttributesCommand({
          UserPoolId: USER_POOL_ID,
          Username: userId,
          UserAttributes: attributes,
        }));
        log.info('cognito attributes updated');
      } catch (cognitoError: any) {
        log.warn('failed to update cognito', { error: cognitoError.message });
      }
    }

    log.info('profile updated');

    return envelope({ statusCode: 200, message: 'Profile updated successfully' });
  } catch (error: any) {
    log.error('failed to update user profile', { error: error.message });
    return errorResponse(500, ErrorCodes.INTERNAL_ERROR, 'Failed to update user profile');
  }
};

