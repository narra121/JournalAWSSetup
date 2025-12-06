import { APIGatewayProxyHandlerV2 } from 'aws-lambda';
import { ddb } from '../../shared/dynamo';
import { GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import { errorResponse, envelope, ErrorCodes } from '../../shared/validation';
import { makeLogger } from '../../shared/logger';

const USER_PREFERENCES_TABLE = process.env.USER_PREFERENCES_TABLE!;

export const handler: APIGatewayProxyHandlerV2 = async (event) => {
  const rc: any = event.requestContext as any;
  const claims = rc?.authorizer?.jwt?.claims || {};
  const userId = claims.sub;
  const log = makeLogger({ requestId: event.requestContext.requestId, userId });
  
  log.info('update-user-preferences invoked');
  
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
    // Get current preferences
    const result = await ddb.send(new GetCommand({
      TableName: USER_PREFERENCES_TABLE,
      Key: { userId }
    }));

    const preferences = result.Item || {
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

    // Update with provided values
    if (data.darkMode !== undefined) preferences.darkMode = data.darkMode;
    if (data.currency) preferences.currency = data.currency;
    if (data.timezone) preferences.timezone = data.timezone;
    preferences.updatedAt = new Date().toISOString();

    await ddb.send(new PutCommand({
      TableName: USER_PREFERENCES_TABLE,
      Item: preferences
    }));

    log.info('preferences updated');
    
    return envelope({ statusCode: 200, data: { preferences } });
  } catch (error: any) {
    log.error('failed to update preferences', { error: error.message });
    return errorResponse(500, ErrorCodes.INTERNAL_ERROR, 'Failed to update preferences');
  }
};

