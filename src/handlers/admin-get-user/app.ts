import type { ApiHandler } from '../../shared/types';
import {
  CognitoIdentityProviderClient,
  AdminGetUserCommand,
} from '@aws-sdk/client-cognito-identity-provider';
import { QueryCommand, GetCommand } from '@aws-sdk/lib-dynamodb';
import { ddb } from '../../shared/dynamo';
import { envelope, errorResponse, ErrorCodes, errorFromException } from '../../shared/validation';
import { makeLogger } from '../../shared/logger';
import { resolveCognitoUsername } from '../../shared/cognitoUser';
import { loadFullRecords } from '../../shared/tradeRecords';

const cognito = new CognitoIdentityProviderClient({});

const USER_POOL_ID = process.env.USER_POOL_ID!;
const TRADES_TABLE = process.env.TRADES_TABLE!;
const ACCOUNTS_TABLE = process.env.ACCOUNTS_TABLE!;
const GOALS_TABLE = process.env.GOALS_TABLE!;
const RULES_TABLE = process.env.RULES_TABLE!;
const SUBSCRIPTIONS_TABLE = process.env.SUBSCRIPTIONS_TABLE!;
const USER_PREFERENCES_TABLE = process.env.USER_PREFERENCES_TABLE!;

const RECENT_TRADES = 20;

/** The newest trades by open date (trades-by-date-gsi), without soft-deleted ones. Reads twice the wanted rows to leave room for deleted ones. */
async function recentTrades(userId: string): Promise<any[]> {
  const res = await ddb.send(
    new QueryCommand({
      TableName: TRADES_TABLE,
      IndexName: 'trades-by-date-gsi',
      KeyConditionExpression: 'userId = :u',
      ExpressionAttributeValues: { ':u': userId },
      ScanIndexForward: false,
      Limit: RECENT_TRADES * 2,
    }),
  );
  const rows = res.Items ?? [];
  const full = await loadFullRecords(userId, rows);
  return rows.map((r) => full.get(r.tradeId)).filter((t) => t && !t.deletedAt).slice(0, RECENT_TRADES);
}

/** All live trades of the user. Counting reads the whole partition (paid per item), so only this single-user view does it. */
async function countTrades(userId: string): Promise<number> {
  let count = 0;
  let lastKey: Record<string, any> | undefined;
  do {
    const res = await ddb.send(
      new QueryCommand({
        TableName: TRADES_TABLE,
        KeyConditionExpression: 'userId = :u',
        FilterExpression: 'attribute_not_exists(deletedAt)',
        ExpressionAttributeValues: { ':u': userId },
        Select: 'COUNT',
        ExclusiveStartKey: lastKey,
      }),
    );
    count += res.Count ?? 0;
    lastKey = res.LastEvaluatedKey;
  } while (lastKey);
  return count;
}

export const handler: ApiHandler = async (event) => {
  const log = makeLogger({ requestId: event.requestContext?.requestId });

  try {
    const userId = event.pathParameters?.userId;
    if (!userId) {
      return errorResponse(400, ErrorCodes.VALIDATION_ERROR, 'userId path parameter is required');
    }

    const [cognitoUser, recent, tradeCount, accountsResult, goalsResult, rulesResult, subscriptionResult, preferencesResult] =
      await Promise.all([
        resolveCognitoUsername(USER_POOL_ID, userId).then((Username) =>
          cognito.send(new AdminGetUserCommand({ UserPoolId: USER_POOL_ID, Username })),
        ),
        recentTrades(userId),
        countTrades(userId),
        ddb.send(
          new QueryCommand({
            TableName: ACCOUNTS_TABLE,
            KeyConditionExpression: 'userId = :u',
            ExpressionAttributeValues: { ':u': userId },
          }),
        ),
        ddb.send(
          new QueryCommand({
            TableName: GOALS_TABLE,
            KeyConditionExpression: 'userId = :u',
            ExpressionAttributeValues: { ':u': userId },
          }),
        ),
        ddb.send(
          new QueryCommand({
            TableName: RULES_TABLE,
            KeyConditionExpression: 'userId = :u',
            ExpressionAttributeValues: { ':u': userId },
          }),
        ),
        ddb.send(
          new GetCommand({
            TableName: SUBSCRIPTIONS_TABLE,
            Key: { userId },
          }),
        ),
        ddb.send(
          new GetCommand({
            TableName: USER_PREFERENCES_TABLE,
            Key: { userId },
          }),
        ),
      ]);

    // Extract Cognito user attributes
    const attrs = cognitoUser.UserAttributes || [];
    const attrMap: Record<string, string> = {};
    for (const a of attrs) {
      if (a.Name && a.Value) attrMap[a.Name] = a.Value;
    }

    const hasGoogle = attrs.some(
      (a) => a.Name === 'identities' && a.Value?.includes('Google'),
    );

    const data = {
      userId,
      email: attrMap['email'] || null,
      name: attrMap['name'] || null,
      status: cognitoUser.UserStatus || null,
      createdAt: cognitoUser.UserCreateDate?.toISOString() || null,
      enabled: cognitoUser.Enabled ?? null,
      hasGoogle,
      accounts: accountsResult.Items || [],
      recentTrades: recent,
      tradeCount,
      goals: goalsResult.Items || [],
      rules: rulesResult.Items || [],
      subscription: subscriptionResult.Item || null,
      preferences: preferencesResult.Item || null,
    };

    log.info('Admin fetched user detail', { targetUserId: userId });

    return envelope({
      statusCode: 200,
      data,
      message: 'User detail retrieved successfully',
    });
  } catch (err: any) {
    log.error('Admin get user error', { error: err.message });
    return errorFromException(err, true);
  }
};
