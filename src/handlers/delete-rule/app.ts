import { APIGatewayProxyHandlerV2 } from 'aws-lambda';
import { ddb } from '../../shared/dynamo';
import { DeleteCommand, GetCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { errorResponse, envelope, ErrorCodes } from '../../shared/validation';
import { makeLogger } from '../../shared/logger';
import { getUserId } from '../../shared/auth';
import { checkSubscription } from '../../shared/subscription';

const RULES_TABLE = process.env.RULES_TABLE!;
const DAILY_STATS_TABLE = process.env.DAILY_STATS_TABLE!;

export const handler: APIGatewayProxyHandlerV2 = async (event) => {
  const userId = getUserId(event);
  const log = makeLogger({ requestId: event.requestContext.requestId, userId });
  
  const ruleId = event.pathParameters?.ruleId;
  log.info('delete-rule invoked', { ruleId });
  
  if (!userId) {
    log.warn('unauthorized request');
    return errorResponse(401, ErrorCodes.UNAUTHORIZED, 'Unauthorized');
  }

  const subError = await checkSubscription(userId);
  if (subError) return subError;

  if (!ruleId) {
    log.warn('missing ruleId');
    return errorResponse(400, ErrorCodes.VALIDATION_ERROR, 'Missing ruleId');
  }

  try {
    // Verify rule exists and belongs to user
    const existing = await ddb.send(new GetCommand({
      TableName: RULES_TABLE,
      Key: { userId, ruleId }
    }));

    if (!existing.Item) {
      log.warn('rule not found', { ruleId });
      return errorResponse(404, ErrorCodes.NOT_FOUND, 'Rule not found');
    }

    const ruleToDelete = existing.Item;

    // Extract the base ruleId (UUID) from composite SK for DailyStats lookup
    const baseRuleId = ruleId.includes('#') ? ruleId.split('#').pop()! : ruleId;

    // Check if rule is referenced in any DailyStats brokenRulesCounts
    let exclusiveStartKey: Record<string, any> | undefined;
    do {
      const statsResult = await ddb.send(new QueryCommand({
        TableName: DAILY_STATS_TABLE,
        KeyConditionExpression: 'userId = :uid',
        ExpressionAttributeValues: { ':uid': userId },
        ProjectionExpression: 'brokenRulesCounts',
        ExclusiveStartKey: exclusiveStartKey,
      }));

      for (const record of statsResult.Items || []) {
        if (record.brokenRulesCounts && (record.brokenRulesCounts[ruleId] > 0 || record.brokenRulesCounts[baseRuleId] > 0)) {
          log.info('rule is in use, cannot delete', { ruleId });
          return errorResponse(409, ErrorCodes.RULE_IN_USE, 'This rule is broken in one or more trades. You can edit the rule text instead.');
        }
      }

      exclusiveStartKey = statsResult.LastEvaluatedKey;
    } while (exclusiveStartKey);

    await ddb.send(new DeleteCommand({
      TableName: RULES_TABLE,
      Key: { userId, ruleId }
    }));

    log.info('rule deleted', { ruleId });
    
    // Return deleted rule for frontend cache optimization
    return envelope({ statusCode: 200, data: { rule: ruleToDelete }, message: 'Rule deleted successfully' });
  } catch (error: any) {
    log.error('failed to delete rule', { error: error.message });
    return errorResponse(500, ErrorCodes.INTERNAL_ERROR, 'Failed to delete rule');
  }
};

