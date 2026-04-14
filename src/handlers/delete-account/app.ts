import { APIGatewayProxyHandlerV2 } from 'aws-lambda';
import { ddb } from '../../shared/dynamo';
import { DeleteCommand, GetCommand, QueryCommand, BatchWriteCommand } from '@aws-sdk/lib-dynamodb';
import { errorResponse, envelope, ErrorCodes } from '../../shared/validation';
import { makeLogger } from '../../shared/logger';
import { removeImagesForTrade } from '../../shared/images';
import { getUserId } from '../../shared/auth';
import { checkSubscription } from '../../shared/subscription';

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

export const handler: APIGatewayProxyHandlerV2 = async (event) => {
  const userId = getUserId(event);
  const log = makeLogger({ requestId: event.requestContext.requestId, userId });
  
  const accountId = event.pathParameters?.accountId;
  log.info('delete-account invoked', { accountId });
  
  if (!userId) {
    log.warn('unauthorized request');
    return errorResponse(401, ErrorCodes.UNAUTHORIZED, 'Unauthorized');
  }

  const subError = await checkSubscription(userId);
  if (subError) return subError;

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
    
    // Delete images for each trade
    if (tradesToDelete.length > 0) {
      log.info('deleting images for trades', { count: tradesToDelete.length });
      
      // Delete images in parallel batches to improve performance
      const imageDeletePromises = tradesToDelete.map(trade => 
        removeImagesForTrade(userId, trade.tradeId)
      );
      
      await Promise.all(imageDeletePromises);
      log.info('deleted all trade images', { count: tradesToDelete.length });
    }
    
    // Delete trades and goals in parallel (different tables, no contention)
    const deleteTrades = async () => {
      const batchSize = 25;
      for (let i = 0; i < tradesToDelete.length; i += batchSize) {
        const batch = tradesToDelete.slice(i, i + batchSize);
        await ddb.send(new BatchWriteCommand({
          RequestItems: {
            [TRADES_TABLE]: batch.map(trade => ({
              DeleteRequest: {
                Key: { userId, tradeId: trade.tradeId }
              }
            }))
          }
        }));
        log.info('deleted trade batch', { batchNumber: Math.floor(i / batchSize) + 1, batchSize: batch.length });
      }
    };

    const deleteGoals = async () => {
      const batchSize = 25;
      for (let i = 0; i < goalsToDelete.length; i += batchSize) {
        const batch = goalsToDelete.slice(i, i + batchSize);
        await ddb.send(new BatchWriteCommand({
          RequestItems: {
            [GOALS_TABLE]: batch.map(goal => ({
              DeleteRequest: {
                Key: { userId, goalId: goal.goalId }
              }
            }))
          }
        }));
        log.info('deleted goal batch', { batchNumber: Math.floor(i / batchSize) + 1, batchSize: batch.length });
      }
    };

    await Promise.all([deleteTrades(), deleteGoals()]);

    // Delete the account
    await ddb.send(new DeleteCommand({
      TableName: ACCOUNTS_TABLE,
      Key: { userId, accountId }
    }));

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

