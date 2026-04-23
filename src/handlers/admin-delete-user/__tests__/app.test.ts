import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import {
  CognitoIdentityProviderClient,
  AdminDeleteUserCommand,
} from '@aws-sdk/client-cognito-identity-provider';
import { DynamoDBDocumentClient, QueryCommand, DeleteCommand } from '@aws-sdk/lib-dynamodb';
import type { APIGatewayProxyEventV2 } from 'aws-lambda';

// ─── Env (must be before any module-scope reads) ──────────────
vi.stubEnv('USER_POOL_ID', 'us-east-1_TestPool');
vi.stubEnv('TRADES_TABLE', 'test-trades');
vi.stubEnv('ACCOUNTS_TABLE', 'test-accounts');
vi.stubEnv('GOALS_TABLE', 'test-goals');
vi.stubEnv('RULES_TABLE', 'test-rules');
vi.stubEnv('DAILY_STATS_TABLE', 'test-daily-stats');
vi.stubEnv('SUBSCRIPTIONS_TABLE', 'test-subscriptions');
vi.stubEnv('USER_PREFERENCES_TABLE', 'test-preferences');
vi.stubEnv('SAVED_OPTIONS_TABLE', 'test-saved-options');

// ─── SDK mocks ────────────────────────────────────────────────
const cognitoMock = mockClient(CognitoIdentityProviderClient);
const ddbMock = mockClient(DynamoDBDocumentClient);

// ─── Mock batchWriteDeleteAll ─────────────────────────────────
vi.mock('../../../shared/batchWrite', () => ({
  batchWriteDeleteAll: vi.fn().mockResolvedValue(undefined),
}));

// ─── Helpers ──────────────────────────────────────────────────
const TEST_USER_ID = 'user-abc-123';

function makeEvent(pathUserId?: string, body?: any): APIGatewayProxyEventV2 {
  return {
    version: '2.0',
    routeKey: 'DELETE /v1/admin/users/{userId}',
    rawPath: `/v1/admin/users/${pathUserId || ''}`,
    rawQueryString: '',
    headers: {},
    pathParameters: pathUserId ? { userId: pathUserId } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
    requestContext: {
      accountId: '123',
      apiId: 'api',
      domainName: 'api.example.com',
      domainPrefix: 'api',
      http: { method: 'DELETE', path: `/v1/admin/users/${pathUserId || ''}`, protocol: 'HTTP/1.1', sourceIp: '127.0.0.1', userAgent: 'test' },
      requestId: 'req-1',
      routeKey: 'DELETE /v1/admin/users/{userId}',
      stage: '$default',
      time: '01/Jan/2024:00:00:00 +0000',
      timeEpoch: 0,
    },
    isBase64Encoded: false,
  } as unknown as APIGatewayProxyEventV2;
}

function setupQueryMocks() {
  ddbMock.on(QueryCommand, { TableName: 'test-trades' }).resolves({
    Items: [
      { userId: TEST_USER_ID, tradeId: 'trade-1' },
      { userId: TEST_USER_ID, tradeId: 'trade-2' },
    ],
  });

  ddbMock.on(QueryCommand, { TableName: 'test-accounts' }).resolves({
    Items: [{ userId: TEST_USER_ID, accountId: 'acc-1' }],
  });

  ddbMock.on(QueryCommand, { TableName: 'test-goals' }).resolves({
    Items: [{ userId: TEST_USER_ID, goalId: 'goal-1' }],
  });

  ddbMock.on(QueryCommand, { TableName: 'test-rules' }).resolves({
    Items: [
      { userId: TEST_USER_ID, ruleId: 'rule-1' },
      { userId: TEST_USER_ID, ruleId: 'rule-2' },
      { userId: TEST_USER_ID, ruleId: 'rule-3' },
    ],
  });

  ddbMock.on(QueryCommand, { TableName: 'test-daily-stats' }).resolves({
    Items: [
      { userId: TEST_USER_ID, sk: 'acc-1#2024-06-15' },
    ],
  });

  ddbMock.on(DeleteCommand).resolves({});
  cognitoMock.on(AdminDeleteUserCommand).resolves({});
}

// Dynamic import to ensure env vars are set before module-scope reads
async function getHandler() {
  const mod = await import('../app');
  return mod.handler;
}

beforeEach(async () => {
  cognitoMock.reset();
  ddbMock.reset();
  const { batchWriteDeleteAll } = await import('../../../shared/batchWrite');
  vi.mocked(batchWriteDeleteAll).mockClear();
});

// ─── Tests ────────────────────────────────────────────────────
describe('admin-delete-user handler', () => {
  it('returns 400 if userId path parameter is missing', async () => {
    const handler = await getHandler();
    const event = makeEvent(undefined, { confirmText: 'delete' });
    (event as any).pathParameters = undefined;

    const res = (await handler(event, {} as any, () => {})) as any;

    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(false);
    expect(body.errorCode).toBe('VALIDATION_ERROR');
    expect(body.message).toContain('userId');
  });

  it('returns 400 if confirmText is missing', async () => {
    const handler = await getHandler();

    const res = (await handler(makeEvent(TEST_USER_ID, {}), {} as any, () => {})) as any;

    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(false);
    expect(body.errorCode).toBe('VALIDATION_ERROR');
    expect(body.message).toContain('confirmText');
  });

  it('returns 400 if confirmText is wrong value', async () => {
    const handler = await getHandler();

    const res = (await handler(makeEvent(TEST_USER_ID, { confirmText: 'remove' }), {} as any, () => {})) as any;

    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(false);
    expect(body.errorCode).toBe('VALIDATION_ERROR');
    expect(body.message).toContain('confirmText');
  });

  it('returns 400 if body is invalid JSON', async () => {
    const handler = await getHandler();
    const event = makeEvent(TEST_USER_ID);
    (event as any).body = 'not-json';

    const res = (await handler(event, {} as any, () => {})) as any;

    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(false);
    expect(body.errorCode).toBe('VALIDATION_ERROR');
  });

  it('returns 200 on successful deletion with correct counts', async () => {
    const handler = await getHandler();
    setupQueryMocks();

    const res = (await handler(makeEvent(TEST_USER_ID, { confirmText: 'delete' }), {} as any, () => {})) as any;

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(true);
    expect(body.message).toBe('User deleted successfully');
    expect(body.data).toEqual({
      deletedTrades: 2,
      deletedAccounts: 1,
      deletedGoals: 1,
      deletedRules: 3,
      deletedStats: 1,
    });
  });

  it('calls batchWriteDeleteAll for each table with correct keys', async () => {
    const handler = await getHandler();
    setupQueryMocks();
    const { batchWriteDeleteAll } = await import('../../../shared/batchWrite');

    await handler(makeEvent(TEST_USER_ID, { confirmText: 'delete' }), {} as any, () => {});

    expect(batchWriteDeleteAll).toHaveBeenCalledTimes(5);

    const calls = vi.mocked(batchWriteDeleteAll).mock.calls;
    const tableNames = calls.map((c) => c[0].tableName).sort();
    expect(tableNames).toEqual([
      'test-accounts',
      'test-daily-stats',
      'test-goals',
      'test-rules',
      'test-trades',
    ]);

    // Verify trade keys
    const tradeCall = calls.find((c) => c[0].tableName === 'test-trades');
    expect(tradeCall![0].keys).toEqual([
      { userId: TEST_USER_ID, tradeId: 'trade-1' },
      { userId: TEST_USER_ID, tradeId: 'trade-2' },
    ]);
  });

  it('deletes single-key items (subscriptions, preferences, saved options)', async () => {
    const handler = await getHandler();
    setupQueryMocks();

    await handler(makeEvent(TEST_USER_ID, { confirmText: 'delete' }), {} as any, () => {});

    const deleteCalls = ddbMock.commandCalls(DeleteCommand);
    expect(deleteCalls).toHaveLength(3);

    const deletedTables = deleteCalls.map((c) => c.args[0].input.TableName).sort();
    expect(deletedTables).toEqual([
      'test-preferences',
      'test-saved-options',
      'test-subscriptions',
    ]);

    // Verify all use userId as key
    for (const call of deleteCalls) {
      expect(call.args[0].input.Key).toEqual({ userId: TEST_USER_ID });
    }
  });

  it('calls AdminDeleteUserCommand with correct UserPoolId and Username', async () => {
    const handler = await getHandler();
    setupQueryMocks();

    await handler(makeEvent(TEST_USER_ID, { confirmText: 'delete' }), {} as any, () => {});

    const cognitoCalls = cognitoMock.commandCalls(AdminDeleteUserCommand);
    expect(cognitoCalls).toHaveLength(1);
    expect(cognitoCalls[0].args[0].input).toEqual({
      UserPoolId: 'us-east-1_TestPool',
      Username: TEST_USER_ID,
    });
  });

  it('handles user with no data gracefully', async () => {
    const handler = await getHandler();
    ddbMock.on(QueryCommand).resolves({ Items: [] });
    ddbMock.on(DeleteCommand).resolves({});
    cognitoMock.on(AdminDeleteUserCommand).resolves({});

    const res = (await handler(makeEvent(TEST_USER_ID, { confirmText: 'delete' }), {} as any, () => {})) as any;

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.data).toEqual({
      deletedTrades: 0,
      deletedAccounts: 0,
      deletedGoals: 0,
      deletedRules: 0,
      deletedStats: 0,
    });
  });

  it('returns 500 when Cognito delete fails', async () => {
    const handler = await getHandler();
    ddbMock.on(QueryCommand).resolves({ Items: [] });
    ddbMock.on(DeleteCommand).resolves({});
    cognitoMock.on(AdminDeleteUserCommand).rejects(new Error('Cognito unavailable'));

    const res = (await handler(makeEvent(TEST_USER_ID, { confirmText: 'delete' }), {} as any, () => {})) as any;

    expect(res.statusCode).toBe(500);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(false);
    expect(body.errorCode).toBe('INTERNAL_ERROR');
  });

  it('returns 500 when DynamoDB query fails', async () => {
    const handler = await getHandler();
    ddbMock.on(QueryCommand).rejects(new Error('DynamoDB timeout'));

    const res = (await handler(makeEvent(TEST_USER_ID, { confirmText: 'delete' }), {} as any, () => {})) as any;

    expect(res.statusCode).toBe(500);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(false);
    expect(body.errorCode).toBe('INTERNAL_ERROR');
  });
});
