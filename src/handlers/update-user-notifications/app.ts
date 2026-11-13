import type { ApiHandler } from '../../shared/types';
import { ddb } from '../../shared/dynamo';
import { UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { errorResponse, envelope, ErrorCodes } from '../../shared/validation';
import { makeLogger } from '../../shared/logger';
import { getUserId } from '../../shared/auth';

const USER_PREFERENCES_TABLE = process.env.USER_PREFERENCES_TABLE!;

export const handler: ApiHandler = async (event) => {
  const userId = getUserId(event);
  const log = makeLogger({ requestId: event.requestContext.requestId, userId });

  log.info('update-user-notifications invoked');

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
  // lifecycle-emails tests `weeklyReport === false`, so a string such as "false" would leave the mail on.
  for (const field of ['tradeReminders', 'weeklyReport', 'goalAlerts'] as const) {
    if (data[field] !== undefined && typeof data[field] !== 'boolean') {
      return errorResponse(400, ErrorCodes.VALIDATION_ERROR, `${field} must be true or false`);
    }
  }

  try {
    const setExpressions: string[] = [];
    const expressionAttributeNames: Record<string, string> = {};
    const expressionAttributeValues: Record<string, any> = {};

    if (data.tradeReminders !== undefined) {
      setExpressions.push('#notifications.#tradeReminders = :tradeReminders');
      expressionAttributeNames['#notifications'] = 'notifications';
      expressionAttributeNames['#tradeReminders'] = 'tradeReminders';
      expressionAttributeValues[':tradeReminders'] = data.tradeReminders;
    }
    if (data.weeklyReport !== undefined) {
      setExpressions.push('#notifications.#weeklyReport = :weeklyReport');
      expressionAttributeNames['#notifications'] = 'notifications';
      expressionAttributeNames['#weeklyReport'] = 'weeklyReport';
      expressionAttributeValues[':weeklyReport'] = data.weeklyReport;
    }
    if (data.goalAlerts !== undefined) {
      setExpressions.push('#notifications.#goalAlerts = :goalAlerts');
      expressionAttributeNames['#notifications'] = 'notifications';
      expressionAttributeNames['#goalAlerts'] = 'goalAlerts';
      expressionAttributeValues[':goalAlerts'] = data.goalAlerts;
    }

    setExpressions.push('#updatedAt = :updatedAt');
    expressionAttributeNames['#updatedAt'] = 'updatedAt';
    expressionAttributeValues[':updatedAt'] = new Date().toISOString();

    // Nested SET fails on a missing map, so make sure `notifications` exists first (creates the item for new users).
    await ddb.send(new UpdateCommand({
      TableName: USER_PREFERENCES_TABLE,
      Key: { userId },
      UpdateExpression: 'SET #notifications = if_not_exists(#notifications, :empty)',
      ExpressionAttributeNames: { '#notifications': 'notifications' },
      ExpressionAttributeValues: { ':empty': {} },
    }));

    const result = await ddb.send(new UpdateCommand({
      TableName: USER_PREFERENCES_TABLE,
      Key: { userId },
      UpdateExpression: `SET ${setExpressions.join(', ')}`,
      ExpressionAttributeNames: expressionAttributeNames,
      ExpressionAttributeValues: expressionAttributeValues,
      ReturnValues: 'ALL_NEW'
    }));

    const notifications = result.Attributes?.notifications;

    log.info('notifications updated');

    return envelope({ statusCode: 200, data: { notifications }, message: 'Notifications updated' });
  } catch (error: any) {
    log.error('failed to update notifications', { error: error.message });
    return errorResponse(500, ErrorCodes.INTERNAL_ERROR, 'Failed to update notifications');
  }
};
