import { APIGatewayProxyHandlerV2 } from 'aws-lambda';
import {
  CognitoIdentityProviderClient,
  AdminGetUserCommand,
} from '@aws-sdk/client-cognito-identity-provider';
import { QueryCommand, GetCommand } from '@aws-sdk/lib-dynamodb';
import { ddb } from '../../shared/dynamo';
import { envelope, errorResponse, ErrorCodes, errorFromException } from '../../shared/validation';
import { makeLogger } from '../../shared/logger';

const cognito = new CognitoIdentityProviderClient({});

const USER_POOL_ID = process.env.USER_POOL_ID!;
const TRADES_TABLE = process.env.TRADES_TABLE!;
const ACCOUNTS_TABLE = process.env.ACCOUNTS_TABLE!;
const GOALS_TABLE = process.env.GOALS_TABLE!;
const RULES_TABLE = process.env.RULES_TABLE!;
const SUBSCRIPTIONS_TABLE = process.env.SUBSCRIPTIONS_TABLE!;
const USER_PREFERENCES_TABLE = process.env.USER_PREFERENCES_TABLE!;

export const handler: APIGatewayProxyHandlerV2 = async (event) => {
  const log = makeLogger({ requestId: event.requestContext?.requestId });

  try {
    const userId = event.pathParameters?.userId;
    if (!userId) {
      return errorResponse(400, ErrorCodes.VALIDATION_ERROR, 'userId path parameter is required');
    }

    const [cognitoUser, tradesResult, accountsResult, goalsResult, rulesResult, subscriptionResult, preferencesResult] =
      await Promise.all([
        cognito.send(
          new AdminGetUserCommand({
            UserPoolId: USER_POOL_ID,
            Username: userId,
          }),
        ),
        ddb.send(
          new QueryCommand({
            TableName: TRADES_TABLE,
            KeyConditionExpression: 'userId = :u',
            ExpressionAttributeValues: { ':u': userId },
            Limit: 20,
            ScanIndexForward: false,
          }),
        ),
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
      recentTrades: tradesResult.Items || [],
      tradeCount: tradesResult.Count ?? 0,
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
