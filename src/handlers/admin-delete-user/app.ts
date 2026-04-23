import { APIGatewayProxyHandlerV2 } from 'aws-lambda';
import {
  CognitoIdentityProviderClient,
  AdminDeleteUserCommand,
} from '@aws-sdk/client-cognito-identity-provider';
import { QueryCommand, DeleteCommand } from '@aws-sdk/lib-dynamodb';
import { ddb } from '../../shared/dynamo';
import { batchWriteDeleteAll } from '../../shared/batchWrite';
import { envelope, errorResponse, ErrorCodes, errorFromException } from '../../shared/validation';
import { makeLogger } from '../../shared/logger';

const cognito = new CognitoIdentityProviderClient({});

const USER_POOL_ID = process.env.USER_POOL_ID!;
const TRADES_TABLE = process.env.TRADES_TABLE!;
const ACCOUNTS_TABLE = process.env.ACCOUNTS_TABLE!;
const GOALS_TABLE = process.env.GOALS_TABLE!;
const RULES_TABLE = process.env.RULES_TABLE!;
const DAILY_STATS_TABLE = process.env.DAILY_STATS_TABLE!;
const SUBSCRIPTIONS_TABLE = process.env.SUBSCRIPTIONS_TABLE!;
const USER_PREFERENCES_TABLE = process.env.USER_PREFERENCES_TABLE!;
const SAVED_OPTIONS_TABLE = process.env.SAVED_OPTIONS_TABLE!;

async function queryAllKeys(
  tableName: string,
  userId: string,
  projectionExpression: string,
): Promise<Record<string, any>[]> {
  const items: Record<string, any>[] = [];
  let lastKey: Record<string, any> | undefined;

  do {
    const result = await ddb.send(
      new QueryCommand({
        TableName: tableName,
        KeyConditionExpression: 'userId = :u',
        ExpressionAttributeValues: { ':u': userId },
        ProjectionExpression: projectionExpression,
        ExclusiveStartKey: lastKey,
      }),
    );
    if (result.Items) items.push(...result.Items);
    lastKey = result.LastEvaluatedKey;
  } while (lastKey);

  return items;
}

export const handler: APIGatewayProxyHandlerV2 = async (event) => {
  const log = makeLogger({ requestId: event.requestContext?.requestId });

  try {
    const userId = event.pathParameters?.userId;
    if (!userId) {
      return errorResponse(400, ErrorCodes.VALIDATION_ERROR, 'userId path parameter is required');
    }

    // Parse and validate confirmation
    let body: any;
    try {
      body = JSON.parse(event.body || '{}');
    } catch {
      return errorResponse(400, ErrorCodes.VALIDATION_ERROR, 'Invalid JSON body');
    }

    if (body.confirmText !== 'delete') {
      return errorResponse(400, ErrorCodes.VALIDATION_ERROR, 'confirmText must be "delete"');
    }

    log.info('Admin deleting user', { targetUserId: userId });

    // Query all tables for user's items (keys only)
    const [tradeKeys, accountKeys, goalKeys, ruleKeys, statsKeys] = await Promise.all([
      queryAllKeys(TRADES_TABLE, userId, 'userId, tradeId'),
      queryAllKeys(ACCOUNTS_TABLE, userId, 'userId, accountId'),
      queryAllKeys(GOALS_TABLE, userId, 'userId, goalId'),
      queryAllKeys(RULES_TABLE, userId, 'userId, ruleId'),
      queryAllKeys(DAILY_STATS_TABLE, userId, 'userId, sk'),
    ]);

    // Batch-delete all multi-key items
    await Promise.all([
      batchWriteDeleteAll({ ddb, tableName: TRADES_TABLE, keys: tradeKeys, log }),
      batchWriteDeleteAll({ ddb, tableName: ACCOUNTS_TABLE, keys: accountKeys, log }),
      batchWriteDeleteAll({ ddb, tableName: GOALS_TABLE, keys: goalKeys, log }),
      batchWriteDeleteAll({ ddb, tableName: RULES_TABLE, keys: ruleKeys, log }),
      batchWriteDeleteAll({ ddb, tableName: DAILY_STATS_TABLE, keys: statsKeys, log }),
    ]);

    // Delete single-key items
    await Promise.all([
      ddb.send(new DeleteCommand({ TableName: SUBSCRIPTIONS_TABLE, Key: { userId } })),
      ddb.send(new DeleteCommand({ TableName: USER_PREFERENCES_TABLE, Key: { userId } })),
      ddb.send(new DeleteCommand({ TableName: SAVED_OPTIONS_TABLE, Key: { userId } })),
    ]);

    // Delete Cognito user
    await cognito.send(
      new AdminDeleteUserCommand({
        UserPoolId: USER_POOL_ID,
        Username: userId,
      }),
    );

    log.info('Admin deleted user successfully', {
      targetUserId: userId,
      deletedTrades: tradeKeys.length,
      deletedAccounts: accountKeys.length,
      deletedGoals: goalKeys.length,
      deletedRules: ruleKeys.length,
      deletedStats: statsKeys.length,
    });

    return envelope({
      statusCode: 200,
      data: {
        deletedTrades: tradeKeys.length,
        deletedAccounts: accountKeys.length,
        deletedGoals: goalKeys.length,
        deletedRules: ruleKeys.length,
        deletedStats: statsKeys.length,
      },
      message: 'User deleted successfully',
    });
  } catch (err: any) {
    log.error('Admin delete user error', { error: err.message });
    return errorFromException(err, true);
  }
};
