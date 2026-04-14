import { APIGatewayProxyHandlerV2 } from 'aws-lambda';
import { ddb } from '../../shared/dynamo';
import { UpdateCommand, GetCommand } from '@aws-sdk/lib-dynamodb';
import { errorResponse, envelope, ErrorCodes } from '../../shared/validation';
import { makeLogger } from '../../shared/logger';
import { getUserId } from '../../shared/auth';
import { checkSubscription } from '../../shared/subscription';

const RULES_TABLE = process.env.RULES_TABLE!;

export const handler: APIGatewayProxyHandlerV2 = async (event) => {
  const userId = getUserId(event);
  const log = makeLogger({ requestId: event.requestContext.requestId, userId });
  
  const ruleId = event.pathParameters?.ruleId;
  log.info('toggle-rule invoked', { ruleId });
  
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

  // Parse body if provided (for explicit completed value)
  let body: any = null;
  if (event.body) {
    try {
      body = JSON.parse(event.body);
    } catch (e) {
      // Ignore parse errors — body is optional for toggle
    }
  }

  try {
    // Get current rule state
    const existing = await ddb.send(new GetCommand({
      TableName: RULES_TABLE,
      Key: { userId, ruleId }
    }));

    if (!existing.Item) {
      log.warn('rule not found', { ruleId });
      return errorResponse(404, ErrorCodes.NOT_FOUND, 'Rule not found');
    }

    const now = new Date().toISOString();
    const newCompleted = body && typeof body.completed === 'boolean' ? body.completed : !existing.Item.completed;
    
    const result = await ddb.send(new UpdateCommand({
      TableName: RULES_TABLE,
      Key: { userId, ruleId },
      UpdateExpression: 'SET #completed = :completed, #updatedAt = :updatedAt',
      ExpressionAttributeNames: {
        '#completed': 'completed',
        '#updatedAt': 'updatedAt'
      },
      ExpressionAttributeValues: {
        ':completed': newCompleted,
        ':updatedAt': now
      },
      ReturnValues: 'ALL_NEW'
    }));

    log.info('rule toggled', { ruleId, completed: newCompleted });
    
    return envelope({ statusCode: 200, data: { rule: result.Attributes } });
  } catch (error: any) {
    log.error('failed to toggle rule', { error: error.message });
    return errorResponse(500, ErrorCodes.INTERNAL_ERROR, 'Failed to toggle rule');
  }
};
