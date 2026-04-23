import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import {
  CognitoIdentityProviderClient,
  AdminGetUserCommand,
} from '@aws-sdk/client-cognito-identity-provider';
import { DynamoDBDocumentClient, QueryCommand, GetCommand } from '@aws-sdk/lib-dynamodb';
import type { APIGatewayProxyEventV2 } from 'aws-lambda';

// ─── Env (must be before any module-scope reads) ──────────────
vi.stubEnv('USER_POOL_ID', 'us-east-1_TestPool');
vi.stubEnv('TRADES_TABLE', 'test-trades');
vi.stubEnv('ACCOUNTS_TABLE', 'test-accounts');
vi.stubEnv('GOALS_TABLE', 'test-goals');
vi.stubEnv('RULES_TABLE', 'test-rules');
vi.stubEnv('SUBSCRIPTIONS_TABLE', 'test-subscriptions');
vi.stubEnv('USER_PREFERENCES_TABLE', 'test-preferences');

// ─── SDK mocks ────────────────────────────────────────────────
const cognitoMock = mockClient(CognitoIdentityProviderClient);
const ddbMock = mockClient(DynamoDBDocumentClient);

// ─── Helpers ──────────────────────────────────────────────────
function makeEvent(pathUserId?: string): APIGatewayProxyEventV2 {
  return {
    version: '2.0',
    routeKey: 'GET /v1/admin/users/{userId}',
    rawPath: `/v1/admin/users/${pathUserId || ''}`,
    rawQueryString: '',
    headers: {},
    pathParameters: pathUserId ? { userId: pathUserId } : undefined,
    requestContext: {
      accountId: '123',
      apiId: 'api',
      domainName: 'api.example.com',
      domainPrefix: 'api',
      http: { method: 'GET', path: `/v1/admin/users/${pathUserId || ''}`, protocol: 'HTTP/1.1', sourceIp: '127.0.0.1', userAgent: 'test' },
      requestId: 'req-1',
      routeKey: 'GET /v1/admin/users/{userId}',
      stage: '$default',
      time: '01/Jan/2024:00:00:00 +0000',
      timeEpoch: 0,
    },
    isBase64Encoded: false,
  } as unknown as APIGatewayProxyEventV2;
}

const TEST_USER_ID = 'user-abc-123';
const TEST_DATE = new Date('2026-01-15T10:30:00Z');

function setupCognito() {
  cognitoMock.on(AdminGetUserCommand).resolves({
    Username: TEST_USER_ID,
    UserAttributes: [
      { Name: 'email', Value: 'test@example.com' },
      { Name: 'name', Value: 'Test User' },
      { Name: 'sub', Value: TEST_USER_ID },
      { Name: 'identities', Value: '[{"providerName":"Google"}]' },
    ],
    UserStatus: 'CONFIRMED',
    UserCreateDate: TEST_DATE,
    Enabled: true,
  });
}

function setupDynamo() {
  ddbMock.on(QueryCommand, { TableName: 'test-trades' }).resolves({
    Items: [
      { tradeId: 'trade-1', symbol: 'AAPL', pnl: 150 },
      { tradeId: 'trade-2', symbol: 'MSFT', pnl: -50 },
    ],
    Count: 2,
  });

  ddbMock.on(QueryCommand, { TableName: 'test-accounts' }).resolves({
    Items: [{ accountId: 'acc-1', name: 'Main Account' }],
  });

  ddbMock.on(QueryCommand, { TableName: 'test-goals' }).resolves({
    Items: [{ goalId: 'goal-1', goalType: 'profit', target: 1000 }],
  });

  ddbMock.on(QueryCommand, { TableName: 'test-rules' }).resolves({
    Items: [{ ruleId: 'rule-1', rule: 'No revenge trading', isActive: true }],
  });

  ddbMock.on(GetCommand, { TableName: 'test-subscriptions' }).resolves({
    Item: { userId: TEST_USER_ID, tier: 'active', plan: 'monthly' },
  });

  ddbMock.on(GetCommand, { TableName: 'test-preferences' }).resolves({
    Item: { userId: TEST_USER_ID, theme: 'dark', currency: 'USD' },
  });
}

// Dynamic import to ensure env vars are set before module-scope reads
async function getHandler() {
  const mod = await import('../app');
  return mod.handler;
}

beforeEach(() => {
  cognitoMock.reset();
  ddbMock.reset();
});

// ─── Tests ────────────────────────────────────────────────────
describe('admin-get-user handler', () => {
  it('returns 400 if userId path parameter is missing', async () => {
    const handler = await getHandler();
    const event = makeEvent();
    (event as any).pathParameters = undefined;

    const res = (await handler(event, {} as any, () => {})) as any;

    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(false);
    expect(body.errorCode).toBe('VALIDATION_ERROR');
    expect(body.message).toContain('userId');
  });

  it('returns 200 with full user detail', async () => {
    const handler = await getHandler();
    setupCognito();
    setupDynamo();

    const res = (await handler(makeEvent(TEST_USER_ID), {} as any, () => {})) as any;

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(true);
    expect(body.message).toBe('User detail retrieved successfully');

    const data = body.data;
    expect(data.userId).toBe(TEST_USER_ID);
    expect(data.email).toBe('test@example.com');
    expect(data.name).toBe('Test User');
    expect(data.status).toBe('CONFIRMED');
    expect(data.createdAt).toBe(TEST_DATE.toISOString());
    expect(data.enabled).toBe(true);
    expect(data.hasGoogle).toBe(true);

    // DynamoDB data
    expect(data.accounts).toHaveLength(1);
    expect(data.accounts[0].accountId).toBe('acc-1');

    expect(data.recentTrades).toHaveLength(2);
    expect(data.tradeCount).toBe(2);

    expect(data.goals).toHaveLength(1);
    expect(data.goals[0].goalType).toBe('profit');

    expect(data.rules).toHaveLength(1);
    expect(data.rules[0].rule).toBe('No revenge trading');

    expect(data.subscription).toEqual({ userId: TEST_USER_ID, tier: 'active', plan: 'monthly' });
    expect(data.preferences).toEqual({ userId: TEST_USER_ID, theme: 'dark', currency: 'USD' });
  });

  it('sends AdminGetUserCommand with correct UserPoolId and Username', async () => {
    const handler = await getHandler();
    setupCognito();
    setupDynamo();

    await handler(makeEvent(TEST_USER_ID), {} as any, () => {});

    const cognitoCalls = cognitoMock.commandCalls(AdminGetUserCommand);
    expect(cognitoCalls).toHaveLength(1);
    expect(cognitoCalls[0].args[0].input).toEqual({
      UserPoolId: 'us-east-1_TestPool',
      Username: TEST_USER_ID,
    });
  });

  it('queries trades with Limit 20 and ScanIndexForward false', async () => {
    const handler = await getHandler();
    setupCognito();
    setupDynamo();

    await handler(makeEvent(TEST_USER_ID), {} as any, () => {});

    const tradeCalls = ddbMock.commandCalls(QueryCommand).filter(
      (c) => c.args[0].input.TableName === 'test-trades',
    );
    expect(tradeCalls).toHaveLength(1);
    expect(tradeCalls[0].args[0].input.Limit).toBe(20);
    expect(tradeCalls[0].args[0].input.ScanIndexForward).toBe(false);
  });

  it('returns hasGoogle false when no Google identity', async () => {
    const handler = await getHandler();
    cognitoMock.on(AdminGetUserCommand).resolves({
      Username: TEST_USER_ID,
      UserAttributes: [
        { Name: 'email', Value: 'test@example.com' },
      ],
      UserStatus: 'CONFIRMED',
      UserCreateDate: TEST_DATE,
      Enabled: true,
    });
    setupDynamo();

    const res = (await handler(makeEvent(TEST_USER_ID), {} as any, () => {})) as any;

    expect(res.statusCode).toBe(200);
    const data = JSON.parse(res.body).data;
    expect(data.hasGoogle).toBe(false);
  });

  it('handles empty DynamoDB results gracefully', async () => {
    const handler = await getHandler();
    setupCognito();

    ddbMock.on(QueryCommand).resolves({ Items: [], Count: 0 });
    ddbMock.on(GetCommand).resolves({ Item: undefined });

    const res = (await handler(makeEvent(TEST_USER_ID), {} as any, () => {})) as any;

    expect(res.statusCode).toBe(200);
    const data = JSON.parse(res.body).data;
    expect(data.accounts).toEqual([]);
    expect(data.recentTrades).toEqual([]);
    expect(data.tradeCount).toBe(0);
    expect(data.goals).toEqual([]);
    expect(data.rules).toEqual([]);
    expect(data.subscription).toBeNull();
    expect(data.preferences).toBeNull();
  });

  it('returns 500 when Cognito call fails', async () => {
    const handler = await getHandler();
    cognitoMock.on(AdminGetUserCommand).rejects(new Error('Cognito unavailable'));
    setupDynamo();

    const res = (await handler(makeEvent(TEST_USER_ID), {} as any, () => {})) as any;

    expect(res.statusCode).toBe(500);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(false);
    expect(body.errorCode).toBe('INTERNAL_ERROR');
  });

  it('returns 500 when DynamoDB call fails', async () => {
    const handler = await getHandler();
    setupCognito();
    ddbMock.on(QueryCommand).rejects(new Error('DynamoDB timeout'));

    const res = (await handler(makeEvent(TEST_USER_ID), {} as any, () => {})) as any;

    expect(res.statusCode).toBe(500);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(false);
    expect(body.errorCode).toBe('INTERNAL_ERROR');
  });
});
