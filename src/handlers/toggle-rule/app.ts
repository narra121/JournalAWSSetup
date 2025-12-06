import { APIGatewayProxyHandlerV2 } from 'aws-lambda';
import { ddb } from '../../shared/dynamo';
import { UpdateCommand, GetCommand } from '@aws-sdk/lib-dynamodb';
import { errorResponse, envelope, ErrorCodes } from '../../shared/validation';
import { makeLogger } from '../../shared/logger';

const RULES_TABLE = process.env.RULES_TABLE!;

export const handler: APIGatewayProxyHandlerV2 = async (event) => {
  const rc: any = event.requestContext as any;
  const claims = rc?.authorizer?.jwt?.claims || {};
  const userId = claims.sub;
  const log = makeLogger({ requestId: event.requestContext.requestId, userId });
  
  const ruleId = event.pathParameters?.ruleId;
  log.info('toggle-rule invoked', { ruleId });
  
  if (!userId) {
    log.warn('unauthorized request');
    return errorResponse(401, ErrorCodes.UNAUTHORIZED, 'Unauthorized');
  }

  if (!ruleId) {
    log.warn('missing ruleId');
    return errorResponse(400, ErrorCodes.VALIDATION_ERROR, 'Missing ruleId');
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
    const newCompleted = !existing.Item.completed;
    
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
    
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(envelope({ statusCode: 200, data: { rule: result.Attributes } }))
    };
  } catch (error: any) {
    log.error('failed to toggle rule', { error: error.message });
    return errorResponse(500, ErrorCodes.INTERNAL_ERROR, 'Failed to toggle rule');
  }
};
