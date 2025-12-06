import { APIGatewayProxyHandlerV2 } from 'aws-lambda';
import { ddb } from '../../shared/dynamo';
import { QueryCommand } from '@aws-sdk/lib-dynamodb';
import { errorResponse, envelope, ErrorCodes } from '../../shared/validation';
import { makeLogger } from '../../shared/logger';

const GOALS_TABLE = process.env.GOALS_TABLE!;

export const handler: APIGatewayProxyHandlerV2 = async (event) => {
  const rc: any = event.requestContext as any;
  const claims = rc?.authorizer?.jwt?.claims || {};
  const userId = claims.sub;
  const log = makeLogger({ requestId: event.requestContext.requestId, userId });
  
  log.info('list-goals invoked');
  
  if (!userId) {
    log.warn('unauthorized request');
    return errorResponse(401, ErrorCodes.UNAUTHORIZED, 'Unauthorized');
  }

  try {
    const result = await ddb.send(new QueryCommand({
      TableName: GOALS_TABLE,
      KeyConditionExpression: 'userId = :userId',
      ExpressionAttributeValues: {
        ':userId': userId
      }
    }));

    const goals = result.Items || [];
    log.info('goals retrieved', { count: goals.length });
    
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(envelope({ statusCode: 200, data: { goals } }))
    };
  } catch (error: any) {
    log.error('failed to list goals', { error: error.message });
    return errorResponse(500, ErrorCodes.INTERNAL_ERROR, 'Failed to retrieve goals');
  }
};

