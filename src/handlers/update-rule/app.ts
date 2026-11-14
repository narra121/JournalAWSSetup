import type { ApiHandler } from '../../shared/types';
import { ddb } from '../../shared/dynamo';
import { UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { errorResponse, envelope, ErrorCodes } from '../../shared/validation';
import { makeLogger } from '../../shared/logger';
import { getUserId } from '../../shared/auth';
import { materializePeriod, periodKeyOf } from '../get-rules-goals/app';

const RULES_TABLE = process.env.RULES_TABLE!;

export const handler: ApiHandler = async (event) => {
  const userId = getUserId(event);
  const log = makeLogger({ requestId: event.requestContext.requestId, userId });
  
  const ruleId = event.pathParameters?.ruleId;
  log.info('update-rule invoked', { ruleId });
  
  if (!userId) {
    log.warn('unauthorized request');
    return errorResponse(401, ErrorCodes.UNAUTHORIZED, 'Unauthorized');
  }

  if (!ruleId) {
    log.warn('missing ruleId');
    return errorResponse(400, ErrorCodes.VALIDATION_ERROR, 'Missing ruleId');
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

  if (!data.rule || typeof data.rule !== 'string' || data.rule.trim().length === 0) {
    log.warn('invalid rule text');
    return errorResponse(400, ErrorCodes.VALIDATION_ERROR, 'Rule text is required');
  }
  data.rule = data.rule.trim();

  try {
    const now = new Date().toISOString();

    // Store the copies the period GET showed before the first write to it.
    const period = periodKeyOf(ruleId);
    if (period) await materializePeriod(userId, period);
    const result = await ddb.send(new UpdateCommand({
      TableName: RULES_TABLE,
      Key: { userId, ruleId },
      // A rule deleted meanwhile must not be recreated as a stub by the update.
      ConditionExpression: 'attribute_exists(ruleId)',
      UpdateExpression: 'SET #rule = :rule, #updatedAt = :updatedAt',
      ExpressionAttributeNames: {
        '#rule': 'rule',
        '#updatedAt': 'updatedAt'
      },
      ExpressionAttributeValues: {
        ':rule': data.rule,
        ':updatedAt': now
      },
      ReturnValues: 'ALL_NEW'
    }));

    log.info('rule updated', { ruleId });
    
    return envelope({ statusCode: 200, data: { rule: result.Attributes } });
  } catch (error: any) {
    if (error.name === 'ConditionalCheckFailedException') {
      log.warn('rule not found', { ruleId });
      return errorResponse(404, ErrorCodes.NOT_FOUND, 'Rule not found');
    }
    log.error('failed to update rule', { error: error.message });
    return errorResponse(500, ErrorCodes.INTERNAL_ERROR, 'Failed to update rule');
  }
};
