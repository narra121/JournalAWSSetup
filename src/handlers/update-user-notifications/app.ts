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

  const flags = (['tradeReminders', 'weeklyReport', 'goalAlerts'] as const).filter((field) => data[field] !== undefined);
  if (flags.length === 0) {
    return errorResponse(400, ErrorCodes.VALIDATION_ERROR, 'Provide at least one of tradeReminders, weeklyReport or goalAlerts');
  }

  try {
    const setExpressions = flags.map((field) => `#notifications.#${field} = :${field}`);
    setExpressions.push('#updatedAt = :updatedAt');
    const expressionAttributeNames: Record<string, string> = { '#notifications': 'notifications', '#updatedAt': 'updatedAt' };
    const expressionAttributeValues: Record<string, any> = { ':updatedAt': new Date().toISOString() };
    for (const field of flags) {
      expressionAttributeNames[`#${field}`] = field;
      expressionAttributeValues[`:${field}`] = data[field];
    }

    const update = () => ddb.send(new UpdateCommand({
      TableName: USER_PREFERENCES_TABLE,
      Key: { userId },
      UpdateExpression: `SET ${setExpressions.join(', ')}`,
      // A nested SET fails on a missing map.
      ConditionExpression: 'attribute_exists(#notifications)',
      ExpressionAttributeNames: expressionAttributeNames,
      ExpressionAttributeValues: expressionAttributeValues,
      ReturnValues: 'ALL_NEW'
    }));

    let result;
    try {
      result = await update();
    } catch (e: any) {
      if (e.name !== 'ConditionalCheckFailedException') throw e;
      // First write for this user: create the `notifications` map (and the item) once, then set the flags.
      await ddb.send(new UpdateCommand({
        TableName: USER_PREFERENCES_TABLE,
        Key: { userId },
        UpdateExpression: 'SET #notifications = if_not_exists(#notifications, :empty)',
        ExpressionAttributeNames: { '#notifications': 'notifications' },
        ExpressionAttributeValues: { ':empty': {} },
      }));
      result = await update();
    }

    const notifications = result.Attributes?.notifications;

    log.info('notifications updated');

    return envelope({ statusCode: 200, data: { notifications }, message: 'Notifications updated' });
  } catch (error: any) {
    log.error('failed to update notifications', { error: error.message });
    return errorResponse(500, ErrorCodes.INTERNAL_ERROR, 'Failed to update notifications');
  }
};
