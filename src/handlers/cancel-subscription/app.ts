import { APIGatewayProxyHandlerV2 } from 'aws-lambda';
import { ddb } from '../../shared/dynamo';
import { UpdateCommand, GetCommand } from '@aws-sdk/lib-dynamodb';
import { errorResponse, envelope, ErrorCodes } from '../../shared/validation';
import { makeLogger } from '../../shared/logger';
import { getUserId } from '../../shared/auth';

const SUBSCRIPTIONS_TABLE = process.env.SUBSCRIPTIONS_TABLE!;

export const handler: APIGatewayProxyHandlerV2 = async (event) => {
  const userId = getUserId(event);
  const log = makeLogger({ requestId: event.requestContext.requestId, userId });
  
  log.info('cancel-subscription invoked');
  
  if (!userId) {
    log.warn('unauthorized request');
    return errorResponse(401, ErrorCodes.UNAUTHORIZED, 'Unauthorized');
  }

  try {
    // Verify subscription exists
    const existing = await ddb.send(new GetCommand({
      TableName: SUBSCRIPTIONS_TABLE,
      Key: { userId }
    }));

    if (!existing.Item) {
      log.warn('subscription not found');
      return errorResponse(404, ErrorCodes.NOT_FOUND, 'Subscription not found');
    }

    const now = new Date().toISOString();
    
    const result = await ddb.send(new UpdateCommand({
      TableName: SUBSCRIPTIONS_TABLE,
      Key: { userId },
      UpdateExpression: 'SET #status = :status, #updatedAt = :updatedAt',
      ExpressionAttributeNames: {
        '#status': 'status',
        '#updatedAt': 'updatedAt'
      },
      ExpressionAttributeValues: {
        ':status': 'cancelled',
        ':updatedAt': now
      },
      ReturnValues: 'ALL_NEW'
    }));

    log.info('subscription cancelled', { userId });
    
    return envelope({ statusCode: 200, data: { subscription: result.Attributes }, message: 'Subscription cancelled' });
  } catch (error: any) {
    log.error('failed to cancel subscription', { error: error.message });
    return errorResponse(500, ErrorCodes.INTERNAL_ERROR, 'Failed to cancel subscription');
  }
};

