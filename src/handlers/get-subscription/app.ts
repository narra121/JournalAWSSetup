import { APIGatewayProxyHandlerV2 } from 'aws-lambda';
import { ddb } from '../../shared/dynamo';
import { GetCommand } from '@aws-sdk/lib-dynamodb';
import { errorResponse, envelope, ErrorCodes } from '../../shared/validation';
import { makeLogger } from '../../shared/logger';
import { getUserId } from '../../shared/auth';

const SUBSCRIPTIONS_TABLE = process.env.SUBSCRIPTIONS_TABLE!;

export const handler: APIGatewayProxyHandlerV2 = async (event) => {
  const userId = getUserId(event);
  const log = makeLogger({ requestId: event.requestContext.requestId, userId });
  
  log.info('get-subscription invoked');
  
  if (!userId) {
    log.warn('unauthorized request');
    return errorResponse(401, ErrorCodes.UNAUTHORIZED, 'Unauthorized');
  }

  try {
    const result = await ddb.send(new GetCommand({
      TableName: SUBSCRIPTIONS_TABLE,
      Key: { userId }
    }));

    if (!result.Item) {
      log.info('no subscription found');
      return envelope({ statusCode: 404, data: { subscription: null }, message: 'No subscription found' });
    }

    const subscription = result.Item;
    log.info('subscription retrieved');
    
    return envelope({ statusCode: 200, data: { subscription }, message: 'Subscription retrieved' });
  } catch (error: any) {
    log.error('failed to get subscription', { error: error.message });
    return errorResponse(500, ErrorCodes.INTERNAL_ERROR, 'Failed to retrieve subscription');
  }
};

