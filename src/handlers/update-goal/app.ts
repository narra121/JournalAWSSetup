import type { ApiHandler } from '../../shared/types';
import { ddb } from '../../shared/dynamo';
import { UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { errorResponse, envelope, ErrorCodes } from '../../shared/validation';
import { makeLogger } from '../../shared/logger';
import { getUserId } from '../../shared/auth';
import { materializePeriod, periodKeyOf } from '../get-rules-goals/app';
import { VALID_PERIODS } from '../../shared/goalDefaults';

const GOALS_TABLE = process.env.GOALS_TABLE!;

export const handler: ApiHandler = async (event) => {
  const userId = getUserId(event);
  const log = makeLogger({ requestId: event.requestContext.requestId, userId });
  
  const goalId = event.pathParameters?.goalId;
  log.info('update-goal invoked', { goalId });
  
  if (!userId) {
    log.warn('unauthorized request');
    return errorResponse(401, ErrorCodes.UNAUTHORIZED, 'Unauthorized');
  }

  if (!goalId) {
    log.warn('missing goalId');
    return errorResponse(400, ErrorCodes.VALIDATION_ERROR, 'Missing goalId');
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

  // Same checks as create-goal: a bad target or period would break the progress calculation.
  if (data.target !== undefined && (typeof data.target !== 'number' || !Number.isFinite(data.target))) {
    return errorResponse(400, ErrorCodes.VALIDATION_ERROR, 'target must be a number');
  }
  if (data.period !== undefined && !(VALID_PERIODS as readonly string[]).includes(data.period)) {
    return errorResponse(400, ErrorCodes.VALIDATION_ERROR, 'period must be one of: weekly, monthly');
  }
  for (const [field, max] of [['title', 100], ['description', 500]] as const) {
    if (data[field] !== undefined && (typeof data[field] !== 'string' || data[field].length > max)) {
      return errorResponse(400, ErrorCodes.VALIDATION_ERROR, `${field} must be text of at most ${max} characters`);
    }
  }
  if (data.accountId !== undefined && data.accountId !== null && (typeof data.accountId !== 'string' || data.accountId.length > 100)) {
    return errorResponse(400, ErrorCodes.VALIDATION_ERROR, 'accountId must be text');
  }

  try {
    const now = new Date().toISOString();
    const updateExpressions: string[] = [];
    const expressionAttributeNames: any = {};
    const expressionAttributeValues: any = {};
    
    let index = 0;
    for (const [key, value] of Object.entries(data)) {
      if (value !== undefined && ['target', 'title', 'description', 'accountId', 'period'].includes(key)) {
        const attrName = `#attr${index}`;
        const attrValue = `:val${index}`;
        updateExpressions.push(`${attrName} = ${attrValue}`);
        expressionAttributeNames[attrName] = key;
        expressionAttributeValues[attrValue] = value;
        index++;
      }
    }

    updateExpressions.push(`#updatedAt = :updatedAt`);
    expressionAttributeNames['#updatedAt'] = 'updatedAt';
    expressionAttributeValues[':updatedAt'] = now;

    // Store the copies the period GET showed before the first write to it.
    const period = periodKeyOf(goalId);
    if (period) await materializePeriod(userId, period);
    const result = await ddb.send(new UpdateCommand({
      TableName: GOALS_TABLE,
      Key: { userId, goalId },
      // A goal deleted meanwhile must not be recreated as a stub by the update.
      ConditionExpression: 'attribute_exists(goalId)',
      UpdateExpression: `SET ${updateExpressions.join(', ')}`,
      ExpressionAttributeNames: expressionAttributeNames,
      ExpressionAttributeValues: expressionAttributeValues,
      ReturnValues: 'ALL_NEW'
    }));

    log.info('goal updated', { goalId });
    
    return envelope({ statusCode: 200, data: { goal: result.Attributes }, message: 'Goal updated successfully' });
  } catch (error: any) {
    if (error.name === 'ConditionalCheckFailedException') {
      log.warn('goal not found', { goalId });
      return errorResponse(404, ErrorCodes.NOT_FOUND, 'Goal not found');
    }
    log.error('failed to update goal', { error: error.message });
    return errorResponse(500, ErrorCodes.INTERNAL_ERROR, 'Failed to update goal');
  }
};
