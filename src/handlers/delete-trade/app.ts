import { APIGatewayProxyHandlerV2 } from 'aws-lambda';
import { ddb } from '../../shared/dynamo';
import { DeleteCommand } from '@aws-sdk/lib-dynamodb';
import { removeImagesForTrade } from '../../shared/images';

const TRADES_TABLE = process.env.TRADES_TABLE!;

export const handler: APIGatewayProxyHandlerV2 = async (event) => {
  try {
    const userId = (event.requestContext as any)?.authorizer?.jwt?.claims?.sub;
    if (!userId) return resp(401, { message: 'Unauthorized' });
    const tradeId = event.pathParameters?.tradeId;
    if (!tradeId) return resp(400, { message: 'Missing tradeId' });

    // Conditional delete ensures existence & ownership (ownership via partition key, existence via attribute_exists)
    await ddb.send(new DeleteCommand({
      TableName: TRADES_TABLE,
      Key: { userId, tradeId },
      ConditionExpression: 'attribute_exists(tradeId)'
    }));

    await removeImagesForTrade(userId, tradeId);
    return resp(200, { message: 'Deleted' });
  } catch (e: any) {
    if (e.name === 'ConditionalCheckFailedException') return resp(404, { message: 'Not found' });
    console.error(e);
    return resp(500, { message: 'Internal error' });
  }
};

function resp(statusCode: number, body: any) { return { statusCode, body: JSON.stringify(body) }; }
