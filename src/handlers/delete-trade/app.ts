import { APIGatewayProxyHandlerV2 } from 'aws-lambda';
import { ddb } from '../../shared/dynamo';
import { GetCommand, DeleteCommand } from '@aws-sdk/lib-dynamodb';
import { removeImagesForTrade } from '../../shared/images';
import { envelope, errorResponse, ErrorCodes } from '../../shared/validation';

const TRADES_TABLE = process.env.TRADES_TABLE!;

export const handler: APIGatewayProxyHandlerV2 = async (event) => {
  try {
    const userId = (event.requestContext as any)?.authorizer?.jwt?.claims?.sub;
    if (!userId) return errorResponse(401, ErrorCodes.UNAUTHORIZED, 'Unauthorized');
    const tradeId = event.pathParameters?.tradeId;
    if (!tradeId) return errorResponse(400, ErrorCodes.VALIDATION_ERROR, 'Missing tradeId');

    // Fetch the trade before deleting to return it in response
    const getResult = await ddb.send(new GetCommand({
      TableName: TRADES_TABLE,
      Key: { userId, tradeId }
    }));

    if (!getResult.Item) {
      return errorResponse(404, ErrorCodes.NOT_FOUND, 'Not found');
    }

    const trade = getResult.Item;

    // Conditional delete ensures existence & ownership (ownership via partition key, existence via attribute_exists)
    await ddb.send(new DeleteCommand({
      TableName: TRADES_TABLE,
      Key: { userId, tradeId },
      ConditionExpression: 'attribute_exists(tradeId)'
    }));

    await removeImagesForTrade(userId, tradeId);
    
    // Return the deleted trade details for frontend cache optimization
    return envelope({ statusCode: 200, data: { trade }, message: 'Deleted' });
  } catch (e: any) {
    if (e.name === 'ConditionalCheckFailedException') return errorResponse(404, ErrorCodes.NOT_FOUND, 'Not found');
    console.error(e);
    return errorResponse(500, ErrorCodes.INTERNAL_ERROR, 'Internal error');
  }
};
