import { APIGatewayProxyHandlerV2 } from 'aws-lambda';
import { ddb } from '../../shared/dynamo';
import { PutCommand } from '@aws-sdk/lib-dynamodb';
import { CognitoIdentityProviderClient, UpdateUserAttributesCommand } from '@aws-sdk/client-cognito-identity-provider';
import { errorResponse, envelope, ErrorCodes } from '../../shared/validation';
import { makeLogger } from '../../shared/logger';

const cognito = new CognitoIdentityProviderClient({});

export const handler: APIGatewayProxyHandlerV2 = async (event) => {
  const rc: any = event.requestContext as any;
  const claims = rc?.authorizer?.jwt?.claims || {};
  const userId = claims.sub;
  const accessToken = event.headers?.authorization || event.headers?.Authorization || '';
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
    // Update Cognito user attributes if name or email provided
    if ((data.name || data.email) && accessToken) {
      const attributes = [];
      if (data.name) attributes.push({ Name: 'name', Value: data.name });
      if (data.email) attributes.push({ Name: 'email', Value: data.email });

      try {
        await cognito.send(new UpdateUserAttributesCommand({
          AccessToken: accessToken.replace('Bearer ', ''),
          UserAttributes: attributes
        }));
        log.info('cognito attributes updated');
      } catch (cognitoError: any) {
        log.warn('failed to update cognito', { error: cognitoError.message });
      }
    }

    log.info('user profile updated');
    
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(envelope({ statusCode: 200, data: { message: 'Profile updated successfully' } }))
    };
  } catch (error: any) {
    log.error('failed to update user profile', { error: error.message });
    return errorResponse(500, ErrorCodes.INTERNAL_ERROR, 'Failed to update user profile');
  }
};
