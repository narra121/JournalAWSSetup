import type { ApiHandler } from '../../shared/types';
import {
  CognitoIdentityProviderClient,
  ListUsersCommand,
} from '@aws-sdk/client-cognito-identity-provider';
import { QueryCommand, GetCommand } from '@aws-sdk/lib-dynamodb';
import { ddb } from '../../shared/dynamo';
import { envelope, errorFromException, errorResponse, ErrorCodes } from '../../shared/validation';
import { makeLogger } from '../../shared/logger';

const cognito = new CognitoIdentityProviderClient({});
const USER_POOL_ID = process.env.USER_POOL_ID!;
const ACCOUNTS_TABLE = process.env.ACCOUNTS_TABLE!;
const SUBSCRIPTIONS_TABLE = process.env.SUBSCRIPTIONS_TABLE!;

function getAttr(
  attrs: { Name?: string; Value?: string }[] | undefined,
  name: string,
): string | undefined {
  return attrs?.find((a) => a.Name === name)?.Value;
}

export const handler: ApiHandler = async (event) => {
  const log = makeLogger({ requestId: event.requestContext?.requestId });
  try {
    log.info('admin-list-users invoked');

    // Pass the previous response's `nextToken` back to get the next 60 users.
    const result = await cognito.send(
      new ListUsersCommand({ UserPoolId: USER_POOL_ID, Limit: 60, PaginationToken: event.queryStringParameters?.nextToken || undefined }),
    );

    const cognitoUsers = result.Users ?? [];

    const users = await Promise.all(
      cognitoUsers.map(async (u) => {
        const userId = getAttr(u.Attributes, 'sub')!;
        const email = getAttr(u.Attributes, 'email');
        const identities = getAttr(u.Attributes, 'identities') ?? '';
        const hasGoogle = identities.includes('Google');

        const [accountsResult, subResult] = await Promise.all([
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
          name: getAttr(u.Attributes, 'name') || '',
          status: u.UserStatus,
          createdAt: u.UserCreateDate?.toISOString(),
          enabled: u.Enabled,
          hasGoogle,
          accountCount: accountsResult.Count ?? 0,
          subscription: sub
            ? {
                status: sub.status,
                tier: sub.tier,
                // Stripe-paid rows carry `currentEnd`; admin grants carry `periodEnd`.
                periodEnd: sub.currentEnd ?? sub.periodEnd,
                source: sub.source,
              }
            : null,
        };
      }),
    );

    log.info('Users retrieved', { count: users.length });
    return envelope({ statusCode: 200, data: { users, nextToken: result.PaginationToken ?? null }, message: 'Users retrieved' });
  } catch (err: any) {
    if (err.name === 'InvalidParameterException') {
      return errorResponse(400, ErrorCodes.VALIDATION_ERROR, 'Invalid nextToken');
    }
    log.error('admin-list-users failed', { error: err.message });
    return errorFromException(err, true);
  }
};
