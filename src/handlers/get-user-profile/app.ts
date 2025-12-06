import { APIGatewayProxyHandlerV2 } from 'aws-lambda';
import { ddb } from '../../shared/dynamo';
import { GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import { CognitoIdentityProviderClient, GetUserCommand, UpdateUserAttributesCommand } from '@aws-sdk/client-cognito-identity-provider';
import { errorResponse, envelope, ErrorCodes } from '../../shared/validation';
import { makeLogger } from '../../shared/logger';

const USER_PREFERENCES_TABLE = process.env.USER_PREFERENCES_TABLE!;
const cognito = new CognitoIdentityProviderClient({});

export const handler: APIGatewayProxyHandlerV2 = async (event) => {
  const rc: any = event.requestContext as any;
  const claims = rc?.authorizer?.jwt?.claims || {};
  const userId = claims.sub;
  const accessToken = event.headers?.authorization || event.headers?.Authorization || '';
  const log = makeLogger({ requestId: event.requestContext.requestId, userId });
  
  log.info('get-user-profile invoked');
  
  if (!userId) {
    log.warn('unauthorized request');
    return errorResponse(401, ErrorCodes.UNAUTHORIZED, 'Unauthorized');
  }

  try {
    // Get user info from Cognito
    let userName = claims.email || '';
    let userEmail = claims.email || '';
    
    try {
      if (accessToken) {
        const cognitoUser = await cognito.send(new GetUserCommand({
          AccessToken: accessToken.replace('Bearer ', '')
        }));
        
        const nameAttr = cognitoUser.UserAttributes?.find(a => a.Name === 'name');
        const emailAttr = cognitoUser.UserAttributes?.find(a => a.Name === 'email');
        
        if (nameAttr?.Value) userName = nameAttr.Value;
        if (emailAttr?.Value) userEmail = emailAttr.Value;
      }
    } catch (cognitoError: any) {
      log.warn('failed to get cognito user', { error: cognitoError.message });
    }

    // Get preferences from DynamoDB
    const prefsResult = await ddb.send(new GetCommand({
      TableName: USER_PREFERENCES_TABLE,
      Key: { userId }
    }));

    const preferences = prefsResult.Item || {
      userId,
      darkMode: false,
      currency: 'USD',
      timezone: 'UTC',
      notifications: {
        tradeReminders: true,
        weeklyReport: true,
        goalAlerts: true
      }
    };

    const user = {
      id: userId,
      name: userName,
      email: userEmail,
      preferences
    };

    log.info('user profile retrieved');
    
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(envelope({ statusCode: 200, data: { user } }))
    };
  } catch (error: any) {
    log.error('failed to get user profile', { error: error.message });
    return errorResponse(500, ErrorCodes.INTERNAL_ERROR, 'Failed to retrieve user profile');
  }
};
