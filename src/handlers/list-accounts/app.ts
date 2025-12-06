import { APIGatewayProxyHandlerV2 } from 'aws-lambda';
import { ddb } from '../../shared/dynamo';
import { QueryCommand } from '@aws-sdk/lib-dynamodb';
import { errorResponse, envelope, ErrorCodes } from '../../shared/validation';
import { makeLogger } from '../../shared/logger';

const ACCOUNTS_TABLE = process.env.ACCOUNTS_TABLE!;

export const handler: APIGatewayProxyHandlerV2 = async (event) => {
  const rc: any = event.requestContext as any;
  const claims = rc?.authorizer?.jwt?.claims || {};
  const userId = claims.sub;
  const log = makeLogger({ requestId: event.requestContext.requestId, userId });
  
  log.info('list-accounts invoked');
  
  if (!userId) {
    log.warn('unauthorized request');
    return errorResponse(401, ErrorCodes.UNAUTHORIZED, 'Unauthorized');
  }

  try {
    const result = await ddb.send(new QueryCommand({
      TableName: ACCOUNTS_TABLE,
      KeyConditionExpression: 'userId = :userId',
      ExpressionAttributeValues: {
        ':userId': userId
      }
    }));

    const accounts = result.Items || [];
    
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
      }
    });
  } catch (error: any) {
    log.error('failed to list accounts', { error: error.message });
    return errorResponse(500, ErrorCodes.INTERNAL_ERROR, 'Failed to retrieve accounts');
  }
};
