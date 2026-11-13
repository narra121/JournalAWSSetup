import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBDocumentClient, QueryCommand, GetCommand } from '@aws-sdk/lib-dynamodb';
import {
  CognitoIdentityProviderClient,
  ListUsersCommand,
} from '@aws-sdk/client-cognito-identity-provider';
import type { APIGatewayProxyEventV2 } from 'aws-lambda';

// ─── Env ───────────────────────────────────────────────────────
vi.stubEnv('USER_POOL_ID', 'us-east-1_TestPool');
vi.stubEnv('TRADES_TABLE', 'test-trades');
vi.stubEnv('ACCOUNTS_TABLE', 'test-accounts');
vi.stubEnv('SUBSCRIPTIONS_TABLE', 'test-subscriptions');

// ─── Mocks ─────────────────────────────────────────────────────
const ddbMock = mockClient(DynamoDBDocumentClient);
const cognitoMock = mockClient(CognitoIdentityProviderClient);

// ─── Helpers ───────────────────────────────────────────────────
function makeEvent(): APIGatewayProxyEventV2 {
  return {
    version: '2.0',
    routeKey: 'GET /v1/admin/users',
    rawPath: '/v1/admin/users',
    rawQueryString: '',
    headers: {},
    requestContext: {
      accountId: '123',
      apiId: 'api',
      domainName: 'api.example.com',
      domainPrefix: 'api',
      http: {
        method: 'GET',
        path: '/v1/admin/users',
        protocol: 'HTTP/1.1',
        sourceIp: '127.0.0.1',
        userAgent: 'test',
      },
      requestId: 'req-1',
      routeKey: 'GET /v1/admin/users',
      stage: '$default',
      time: '01/Jan/2024:00:00:00 +0000',
      timeEpoch: 0,
    },
    body: undefined,
    isBase64Encoded: false,
  } as unknown as APIGatewayProxyEventV2;
}

function makeCognitoUser(overrides?: {
  sub?: string;
  email?: string;
  identities?: string;
  status?: string;
  enabled?: boolean;
  createdAt?: Date;
}): any {
  const sub = overrides?.sub ?? 'user-abc-123';
  const email = overrides?.email ?? 'test@example.com';
  const identities = overrides?.identities;
  const attrs = [
    { Name: 'sub', Value: sub },
    { Name: 'email', Value: email },
  ];
  if (identities !== undefined) {
    attrs.push({ Name: 'identities', Value: identities });
  }
  return {
    Username: sub,
    Attributes: attrs,
    UserStatus: overrides?.status ?? 'CONFIRMED',
    Enabled: overrides?.enabled ?? true,
    UserCreateDate: overrides?.createdAt ?? new Date('2024-06-01T00:00:00Z'),
  };
}

beforeEach(() => {
  ddbMock.reset();
  cognitoMock.reset();
});

// ─── Tests ─────────────────────────────────────────────────────
describe('admin-list-users handler', () => {
  it('returns user list with counts and subscription', async () => {
    const { handler } = await import('../app');

    cognitoMock.on(ListUsersCommand).resolves({
      Users: [
        makeCognitoUser({
          sub: 'user-1',
          email: 'alice@example.com',
          identities: '[{"providerName":"Google"}]',
        }),
      ],
    });

    // Accounts COUNT query
    ddbMock
      .on(QueryCommand, {
        TableName: 'test-accounts',
        KeyConditionExpression: 'userId = :u',
        ExpressionAttributeValues: { ':u': 'user-1' },
        Select: 'COUNT',
      })
      .resolves({ Count: 3 });

    // Subscription GetCommand
    ddbMock
      .on(GetCommand, {
        TableName: 'test-subscriptions',
        Key: { userId: 'user-1' },
      })
      .resolves({
        Item: {
          userId: 'user-1',
          status: 'active',
          tier: 'pro',
          periodEnd: '2025-12-31',
          source: 'stripe',
        },
      });

    const res = (await handler(makeEvent(), {} as any, () => {})) as any;

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(true);
    expect(body.message).toBe('Users retrieved');
    expect(body.data.users).toHaveLength(1);

    const user = body.data.users[0];
    expect(user.userId).toBe('user-1');
    expect(user.email).toBe('alice@example.com');
    expect(user.status).toBe('CONFIRMED');
    expect(user.enabled).toBe(true);
    expect(user.hasGoogle).toBe(true);
    expect(user.tradeCount).toBeUndefined();
    expect(user.accountCount).toBe(3);
    // 2 DynamoDB calls per user: no per-user read of the whole trades partition
    expect(ddbMock.commandCalls(QueryCommand).map((c) => c.args[0].input.TableName)).toEqual(['test-accounts']);
    expect(ddbMock.commandCalls(GetCommand)).toHaveLength(1);
    expect(user.subscription).toEqual({
      status: 'active',
      tier: 'pro',
      periodEnd: '2025-12-31',
      source: 'stripe',
    });
  });

  it('returns empty array when no users', async () => {
    const { handler } = await import('../app');

    cognitoMock.on(ListUsersCommand).resolves({ Users: [] });

    const res = (await handler(makeEvent(), {} as any, () => {})) as any;

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(true);
    expect(body.data.users).toEqual([]);
  });

  it('returns null subscription when user has no subscription record', async () => {
    const { handler } = await import('../app');

    cognitoMock.on(ListUsersCommand).resolves({
      Users: [makeCognitoUser({ sub: 'user-no-sub' })],
    });

    ddbMock.on(QueryCommand).resolves({ Count: 0 });
    ddbMock.on(GetCommand).resolves({ Item: undefined });

    const res = (await handler(makeEvent(), {} as any, () => {})) as any;

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.data.users[0].subscription).toBeNull();
    expect(body.data.users[0].accountCount).toBe(0);
  });

  describe('paging (BE-022)', () => {
    it('passes nextToken from the query string to Cognito and returns the next one', async () => {
      const { handler } = await import('../app');
      cognitoMock.on(ListUsersCommand).resolves({ Users: [makeCognitoUser({ sub: 'user-61' })], PaginationToken: 'page-3' });
      ddbMock.on(QueryCommand).resolves({ Count: 0 });
      ddbMock.on(GetCommand).resolves({ Item: undefined });

      const event = { ...makeEvent(), queryStringParameters: { nextToken: 'page-2' } } as any;
      const res = (await handler(event, {} as any, () => {})) as any;

      expect(cognitoMock.commandCalls(ListUsersCommand)[0].args[0].input).toMatchObject({ Limit: 60, PaginationToken: 'page-2' });
      expect(JSON.parse(res.body).data.nextToken).toBe('page-3');
    });

    it('returns a null nextToken on the last page and sends no token for the first', async () => {
      const { handler } = await import('../app');
      cognitoMock.on(ListUsersCommand).resolves({ Users: [] });

      const res = (await handler(makeEvent(), {} as any, () => {})) as any;

      expect(cognitoMock.commandCalls(ListUsersCommand)[0].args[0].input.PaginationToken).toBeUndefined();
      expect(JSON.parse(res.body).data.nextToken).toBeNull();
    });

    it('answers 400 for a token Cognito rejects', async () => {
      const { handler } = await import('../app');
      cognitoMock.on(ListUsersCommand).rejects(Object.assign(new Error('bad token'), { name: 'InvalidParameterException' }));

      const event = { ...makeEvent(), queryStringParameters: { nextToken: 'garbage' } } as any;
      const res = (await handler(event, {} as any, () => {})) as any;

      expect(res.statusCode).toBe(400);
    });
  });

  it('shows the Stripe period end (currentEnd) for paying users, the grant end otherwise', async () => {
    const { handler } = await import('../app');
    cognitoMock.on(ListUsersCommand).resolves({ Users: [makeCognitoUser({ sub: 'u-paid' }), makeCognitoUser({ sub: 'u-grant' })] });
    ddbMock.on(QueryCommand).resolves({ Count: 0 });
    ddbMock.on(GetCommand, { Key: { userId: 'u-paid' } }).resolves({ Item: { status: 'active', currentEnd: '2026-12-01T00:00:00.000Z' } });
    ddbMock.on(GetCommand, { Key: { userId: 'u-grant' } }).resolves({ Item: { status: 'active', source: 'admin_grant', periodEnd: '2027-01-01T00:00:00.000Z' } });

    const body = JSON.parse(((await handler(makeEvent(), {} as any, () => {})) as any).body);

    expect(body.data.users.map((u: any) => u.subscription.periodEnd)).toEqual(['2026-12-01T00:00:00.000Z', '2027-01-01T00:00:00.000Z']);
  });

  it('sets hasGoogle false when no identities attribute', async () => {
    const { handler } = await import('../app');

    cognitoMock.on(ListUsersCommand).resolves({
      Users: [makeCognitoUser({ sub: 'user-email-only' })],
    });

    ddbMock.on(QueryCommand).resolves({ Count: 0 });
    ddbMock.on(GetCommand).resolves({ Item: undefined });

    const res = (await handler(makeEvent(), {} as any, () => {})) as any;

    const body = JSON.parse(res.body);
    expect(body.data.users[0].hasGoogle).toBe(false);
  });

  it('returns 500 on Cognito error', async () => {
    const { handler } = await import('../app');

    cognitoMock.on(ListUsersCommand).rejects(new Error('Cognito unavailable'));

    const res = (await handler(makeEvent(), {} as any, () => {})) as any;

    expect(res.statusCode).toBe(500);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(false);
  });
});
