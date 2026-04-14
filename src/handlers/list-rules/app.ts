import { APIGatewayProxyHandlerV2 } from 'aws-lambda';
import { ddb } from '../../shared/dynamo';
import { QueryCommand } from '@aws-sdk/lib-dynamodb';
import { errorResponse, envelope, ErrorCodes } from '../../shared/validation';
import { makeLogger } from '../../shared/logger';
import { getUserId } from '../../shared/auth';

const RULES_TABLE = process.env.RULES_TABLE!;

export const handler: APIGatewayProxyHandlerV2 = async (event) => {
  const userId = getUserId(event);
  const log = makeLogger({ requestId: event.requestContext.requestId, userId });
  
  log.info('list-rules invoked');
  
  if (!userId) {
    log.warn('unauthorized request');
    return errorResponse(401, ErrorCodes.UNAUTHORIZED, 'Unauthorized');
  }

  try {
    const rules: any[] = [];
    let lastEvaluatedKey: any;
    do {
      const result = await ddb.send(new QueryCommand({
        TableName: RULES_TABLE,
        KeyConditionExpression: 'userId = :userId',
        ExpressionAttributeValues: {
          ':userId': userId
        },
        ExclusiveStartKey: lastEvaluatedKey
      }));
      if (result.Items) rules.push(...result.Items);
      lastEvaluatedKey = result.LastEvaluatedKey;
    } while (lastEvaluatedKey);
    log.info('rules listed', { count: rules.length });
    
    return envelope({ statusCode: 200, data: { rules }, message: 'Rules retrieved' });
  } catch (error: any) {
    log.error('failed to list rules', { error: error.message });
    return errorResponse(500, ErrorCodes.INTERNAL_ERROR, 'Failed to retrieve rules');
  }
};
