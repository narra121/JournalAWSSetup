import { APIGatewayProxyHandlerV2 } from 'aws-lambda';
import { ddb } from '../../shared/dynamo';
import { DeleteCommand } from '@aws-sdk/lib-dynamodb';
import { removeImagesForTrade } from '../../shared/images';
import { envelope, errorResponse, ErrorCodes } from '../../shared/validation';
import { getUserId } from '../../shared/auth';
import { checkSubscription } from '../../shared/subscription';
import { makeLogger } from '../../shared/logger';

const TRADES_TABLE = process.env.TRADES_TABLE!;

export const handler: APIGatewayProxyHandlerV2 = async (event) => {
  const log = makeLogger({ requestId: event.requestContext.requestId, userId: getUserId(event) ?? undefined });
  try {
    const userId = getUserId(event);
    if (!userId) return errorResponse(401, ErrorCodes.UNAUTHORIZED, 'Unauthorized');

    const subError = await checkSubscription(userId);
    if (subError) return subError;

    const tradeId = event.pathParameters?.tradeId;
    if (!tradeId) return errorResponse(400, ErrorCodes.VALIDATION_ERROR, 'Missing tradeId');

    const deleteResult = await ddb.send(new DeleteCommand({
      TableName: TRADES_TABLE,
      Key: { userId, tradeId },
      ConditionExpression: 'attribute_exists(tradeId)',
      ReturnValues: 'ALL_OLD',
    }));

    const trade = deleteResult.Attributes;
    if (!trade) {
      return errorResponse(404, ErrorCodes.NOT_FOUND, 'Not found');
    }

    await removeImagesForTrade(userId, tradeId);
    
    // Return the deleted trade details for frontend cache optimization
    return envelope({ statusCode: 200, data: { trade }, message: 'Deleted' });
  } catch (e: any) {
    if (e.name === 'ConditionalCheckFailedException') return errorResponse(404, ErrorCodes.NOT_FOUND, 'Not found');
    log.error('delete-trade failed', { error: e.message, stack: e.stack });
    return errorResponse(500, ErrorCodes.INTERNAL_ERROR, 'Internal error');
  }
};
