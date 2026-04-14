import { APIGatewayProxyHandlerV2 } from 'aws-lambda';
import { ddb } from '../../shared/dynamo';
import { QueryCommand } from '@aws-sdk/lib-dynamodb';
import { errorResponse, envelope, ErrorCodes } from '../../shared/validation';
import { makeLogger } from '../../shared/logger';
import { getUserId } from '../../shared/auth';

const ACCOUNTS_TABLE = process.env.ACCOUNTS_TABLE!;

export const handler: APIGatewayProxyHandlerV2 = async (event) => {
  const userId = getUserId(event);
  const log = makeLogger({ requestId: event.requestContext.requestId, userId });
  
  log.info('list-accounts invoked');
  
  if (!userId) {
    log.warn('unauthorized request');
    return errorResponse(401, ErrorCodes.UNAUTHORIZED, 'Unauthorized');
  }

  try {
    const accounts: any[] = [];
    let lastEvaluatedKey: any;
    do {
      const result = await ddb.send(new QueryCommand({
        TableName: ACCOUNTS_TABLE,
        KeyConditionExpression: 'userId = :userId',
        ExpressionAttributeValues: {
          ':userId': userId
        },
        ExclusiveStartKey: lastEvaluatedKey
      }));
      if (result.Items) accounts.push(...result.Items);
      lastEvaluatedKey = result.LastEvaluatedKey;
    } while (lastEvaluatedKey);
    
    // Calculate totals
    const totalBalance = accounts.reduce((sum, acc) => sum + (acc.balance || 0), 0);
    const totalPnl = accounts.reduce((sum, acc) => {
      const pnl = (acc.balance || 0) - (acc.initialBalance || 0);
      return sum + pnl;
    }, 0);

    log.info('accounts retrieved', { count: accounts.length });
    
    return envelope({
      statusCode: 200,
      data: {
        accounts,
        totalBalance,
        totalPnl
      },
      message: 'Accounts retrieved'
    });
  } catch (error: any) {
    log.error('failed to list accounts', { error: error.message });
    return errorResponse(500, ErrorCodes.INTERNAL_ERROR, 'Failed to retrieve accounts');
  }
};
