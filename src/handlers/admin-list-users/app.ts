import { APIGatewayProxyHandlerV2 } from 'aws-lambda';
import {
  CognitoIdentityProviderClient,
  ListUsersCommand,
} from '@aws-sdk/client-cognito-identity-provider';
import { QueryCommand, GetCommand } from '@aws-sdk/lib-dynamodb';
import { ddb } from '../../shared/dynamo';
import { envelope, errorFromException } from '../../shared/validation';
import { makeLogger } from '../../shared/logger';

const cognito = new CognitoIdentityProviderClient({});
const USER_POOL_ID = process.env.USER_POOL_ID!;
const TRADES_TABLE = process.env.TRADES_TABLE!;
const ACCOUNTS_TABLE = process.env.ACCOUNTS_TABLE!;
const SUBSCRIPTIONS_TABLE = process.env.SUBSCRIPTIONS_TABLE!;

function getAttr(
  attrs: { Name?: string; Value?: string }[] | undefined,
  name: string,
): string | undefined {
  return attrs?.find((a) => a.Name === name)?.Value;
}

export const handler: APIGatewayProxyHandlerV2 = async (event) => {
  const log = makeLogger({ requestId: event.requestContext?.requestId });
  try {
    log.info('admin-list-users invoked');

    const result = await cognito.send(
      new ListUsersCommand({ UserPoolId: USER_POOL_ID, Limit: 60 }),
    );

    const cognitoUsers = result.Users ?? [];

    const users = await Promise.all(
      cognitoUsers.map(async (u) => {
        const userId = getAttr(u.Attributes, 'sub')!;
        const email = getAttr(u.Attributes, 'email');
        const identities = getAttr(u.Attributes, 'identities') ?? '';
        const hasGoogle = identities.includes('Google');

        const [tradesResult, accountsResult, subResult] = await Promise.all([
          ddb.send(
            new QueryCommand({
              TableName: TRADES_TABLE,
              KeyConditionExpression: 'userId = :u',
              ExpressionAttributeValues: { ':u': userId },
              Select: 'COUNT',
            }),
          ),
          ddb.send(
            new QueryCommand({
              TableName: ACCOUNTS_TABLE,
              KeyConditionExpression: 'userId = :u',
              ExpressionAttributeValues: { ':u': userId },
              Select: 'COUNT',
            }),
          ),
          ddb.send(
            new GetCommand({
              TableName: SUBSCRIPTIONS_TABLE,
              Key: { userId },
            }),
          ),
        ]);

        const sub = subResult.Item;

        return {
          userId,
          email,
          status: u.UserStatus,
          createdAt: u.UserCreateDate?.toISOString(),
          enabled: u.Enabled,
          hasGoogle,
          tradeCount: tradesResult.Count ?? 0,
          accountCount: accountsResult.Count ?? 0,
          subscription: sub
            ? {
                status: sub.status,
                tier: sub.tier,
                periodEnd: sub.periodEnd,
                source: sub.source,
              }
            : null,
        };
      }),
    );

    log.info('Users retrieved', { count: users.length });
    return envelope({ statusCode: 200, data: { users }, message: 'Users retrieved' });
  } catch (err: any) {
    log.error('admin-list-users failed', { error: err.message });
    return errorFromException(err, true);
  }
};
