import { APIGatewayProxyHandlerV2 } from 'aws-lambda';
import { ddb } from '../../shared/dynamo';
import { UpdateCommand, GetCommand } from '@aws-sdk/lib-dynamodb';
import { errorResponse, envelope, ErrorCodes } from '../../shared/validation';
import { makeLogger } from '../../shared/logger';

const GOALS_TABLE = process.env.GOALS_TABLE!;

export const handler: APIGatewayProxyHandlerV2 = async (event) => {
  const rc: any = event.requestContext as any;
  const claims = rc?.authorizer?.jwt?.claims || {};
  const userId = claims.sub;
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

  try {
    // Verify goal exists and belongs to user
    const existing = await ddb.send(new GetCommand({
      TableName: GOALS_TABLE,
      Key: { userId, goalId }
    }));

    if (!existing.Item) {
      log.warn('goal not found', { goalId });
      return errorResponse(404, ErrorCodes.NOT_FOUND, 'Goal not found');
    }

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

    const result = await ddb.send(new UpdateCommand({
      TableName: GOALS_TABLE,
      Key: { userId, goalId },
      UpdateExpression: `SET ${updateExpressions.join(', ')}`,
      ExpressionAttributeNames: expressionAttributeNames,
      ExpressionAttributeValues: expressionAttributeValues,
      ReturnValues: 'ALL_NEW'
    }));

    log.info('goal updated', { goalId });
    
    return envelope({ statusCode: 200, data: { goal: result.Attributes } });
  } catch (error: any) {
    log.error('failed to update goal', { error: error.message });
    return errorResponse(500, ErrorCodes.INTERNAL_ERROR, 'Failed to update goal');
  }
};
