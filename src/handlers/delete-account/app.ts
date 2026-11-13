import type { ApiHandler } from '../../shared/types';
import { ddb } from '../../shared/dynamo';
import { DeleteCommand, GetCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { errorResponse, envelope, ErrorCodes } from '../../shared/validation';
import { makeLogger } from '../../shared/logger';
import { removeImagesForTrade } from '../../shared/images';
import { getUserId } from '../../shared/auth';
import { batchWriteDeleteAll } from '../../shared/batchWrite';

const ACCOUNTS_TABLE = process.env.ACCOUNTS_TABLE!;
const TRADES_TABLE = process.env.TRADES_TABLE!;
const GOALS_TABLE = process.env.GOALS_TABLE!;

async function queryItemsForAccount(tableName: string, keyField: string, userId: string, accountId: string) {
  const items: any[] = [];
  let lastKey: any;
  do {
    const result = await ddb.send(new QueryCommand({
      TableName: tableName,
      KeyConditionExpression: 'userId = :userId',
      FilterExpression: 'accountId = :accountId',
      ExpressionAttributeValues: { ':userId': userId, ':accountId': accountId },
      ProjectionExpression: keyField,
      ExclusiveStartKey: lastKey,
    }));
    if (result.Items?.length) items.push(...result.Items);
    lastKey = result.LastEvaluatedKey;
  } while (lastKey);
  return items;
}

export const handler: ApiHandler = async (event) => {
  const userId = getUserId(event);
  const log = makeLogger({ requestId: event.requestContext.requestId, userId });
  
  const accountId = event.pathParameters?.accountId;
  log.info('delete-account invoked', { accountId });
  
  if (!userId) {
    log.warn('unauthorized request');
    return errorResponse(401, ErrorCodes.UNAUTHORIZED, 'Unauthorized');
  }

  if (!accountId) {
    log.warn('missing accountId');
    return errorResponse(400, ErrorCodes.VALIDATION_ERROR, 'Missing accountId');
  }

  try {
    // Verify account exists and belongs to user
    const existing = await ddb.send(new GetCommand({
      TableName: ACCOUNTS_TABLE,
      Key: { userId, accountId }
    }));

    if (!existing.Item) {
      log.warn('account not found', { accountId });
      return errorResponse(404, ErrorCodes.NOT_FOUND, 'Account not found');
    }

    // Store account for response
    const accountToDelete = existing.Item;

    // Query trades and goals in parallel
    log.info('fetching trades and goals for account deletion', { accountId });

    const [tradesToDelete, goalsToDelete] = await Promise.all([
      queryItemsForAccount(TRADES_TABLE, 'tradeId', userId, accountId),
      queryItemsForAccount(GOALS_TABLE, 'goalId', userId, accountId),
    ]) as [{ tradeId: string }[], { goalId: string }[]];

    log.info('found items to delete', { trades: tradesToDelete.length, goals: goalsToDelete.length, accountId });
    
    // Delete trades and goals in parallel using batchWriteDeleteAll
    await Promise.all([
      batchWriteDeleteAll({
        ddb,
        tableName: TRADES_TABLE,
        keys: tradesToDelete.map(trade => ({ userId, tradeId: trade.tradeId })),
        log
      }),
      batchWriteDeleteAll({
        ddb,
        tableName: GOALS_TABLE,
        keys: goalsToDelete.map(goal => ({ userId, goalId: goal.goalId })),
        log
      })
    ]);

    // Delete the account
    await ddb.send(new DeleteCommand({
      TableName: ACCOUNTS_TABLE,
      Key: { userId, accountId }
    }));

    // Screenshots last and best effort: the records are already gone, so a storage hiccup must not turn the
    // delete into a 500 or leave the user's data half deleted; failures are logged for a retry by operations.
    if (tradesToDelete.length > 0) {
      const results = await Promise.allSettled(tradesToDelete.map(trade => removeImagesForTrade(userId, trade.tradeId)));
      const failed = results.filter(r => r.status === 'rejected').length;
      if (failed > 0) log.error('image cleanup failed for some trades', { failed, total: tradesToDelete.length, accountId });
    }

    log.info('account and all associated data deleted', {
      accountId,
      tradesDeleted: tradesToDelete.length,
      goalsDeleted: goalsToDelete.length,
    });

    return envelope({
      statusCode: 200,
      message: 'Account deleted successfully',
      data: {
        account: accountToDelete,
        tradesDeleted: tradesToDelete.length,
        goalsDeleted: goalsToDelete.length,
      }
    });
  } catch (error: any) {
    log.error('failed to delete account', { error: error.message });
    return errorResponse(500, ErrorCodes.INTERNAL_ERROR, 'Failed to delete account');
  }
};

