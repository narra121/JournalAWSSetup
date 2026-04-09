import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBDocumentClient, PutCommand, BatchWriteCommand } from '@aws-sdk/lib-dynamodb';
import type { APIGatewayProxyEventV2 } from 'aws-lambda';

// Mock environment variables before importing handler
vi.stubEnv('ACCOUNTS_TABLE', 'test-accounts');
vi.stubEnv('GOALS_TABLE', 'test-goals');

const { handler } = await import('../app.ts');

const ddbMock = mockClient(DynamoDBDocumentClient);

// ─── Helpers ────────────────────────────────────────────────────

function makeJwt(sub: string): string {
  const header = btoa(JSON.stringify({ alg: 'RS256' }));
  const payload = btoa(JSON.stringify({ sub }));
  return `${header}.${payload}.sig`;
}

function makeEvent(body: any, overrides: Partial<APIGatewayProxyEventV2> = {}): APIGatewayProxyEventV2 {
  return {
    version: '2.0',
    routeKey: 'POST /accounts',
    rawPath: '/accounts',
    rawQueryString: '',
    headers: {
      authorization: `Bearer ${makeJwt('user-1')}`,
      ...((overrides as any).headers || {}),
    },
    requestContext: {
      accountId: '123',
      apiId: 'api',
      domainName: 'api.example.com',
      domainPrefix: 'api',
      http: { method: 'POST', path: '/accounts', protocol: 'HTTP/1.1', sourceIp: '127.0.0.1', userAgent: 'test' },
      requestId: 'req-1',
      routeKey: 'POST /accounts',
      stage: '$default',
      time: '01/Jan/2024:00:00:00 +0000',
      timeEpoch: 0,
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
    isBase64Encoded: false,
    ...overrides,
  } as unknown as APIGatewayProxyEventV2;
}

const validAccount = {
  name: 'My Trading Account',
  broker: 'Interactive Brokers',
  type: 'personal',
  status: 'active',
  balance: 10000,
  initialBalance: 10000,
  currency: 'USD',
};

// ─── Tests ──────────────────────────────────────────────────────

beforeEach(() => {
  ddbMock.reset();
  ddbMock.on(PutCommand).resolves({});
  ddbMock.on(BatchWriteCommand).resolves({ UnprocessedItems: {} });
});

describe('create-account handler', () => {
  // ── Success ─────────────────────────────────────────────────

  it('creates an account and returns 201', async () => {
    const res = await handler(makeEvent(validAccount), {} as any, () => {}) as any;

    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(true);
    expect(body.data.account).toBeDefined();
    expect(body.data.account.name).toBe('My Trading Account');
    expect(body.data.account.broker).toBe('Interactive Brokers');
    expect(body.data.account.userId).toBe('user-1');
    expect(body.data.account.accountId).toBeDefined();
    expect(body.data.account.createdAt).toBeDefined();
  });

  it('writes account to DynamoDB', async () => {
    await handler(makeEvent(validAccount), {} as any, () => {}) as any;

    const putCalls = ddbMock.commandCalls(PutCommand);
    expect(putCalls.length).toBeGreaterThanOrEqual(1);
    const putInput = putCalls[0].args[0].input;
    expect(putInput.TableName).toBe('test-accounts');
    expect(putInput.Item?.name).toBe('My Trading Account');
  });

  it('creates default goals for the new account', async () => {
    await handler(makeEvent(validAccount), {} as any, () => {}) as any;

    // Default goals: 4 types x 2 periods (weekly+monthly) = 8 goals
    // These are written via BatchWriteCommand
    const batchCalls = ddbMock.commandCalls(BatchWriteCommand);
    expect(batchCalls.length).toBeGreaterThanOrEqual(1);
  });

  // ── Auth errors ─────────────────────────────────────────────

  it('returns 401 when authorization header is missing', async () => {
    const event = makeEvent(validAccount);
    event.headers = {};
    const res = await handler(event, {} as any, () => {}) as any;

    expect(res.statusCode).toBe(401);
    const body = JSON.parse(res.body);
    expect(body.errorCode).toBe('UNAUTHORIZED');
  });

  // ── Validation errors ───────────────────────────────────────

  it('returns 400 when body is missing', async () => {
    const event = makeEvent(undefined);
    event.body = undefined;
    const res = await handler(event, {} as any, () => {}) as any;

    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.errorCode).toBe('VALIDATION_ERROR');
  });

  it('returns 400 when body is invalid JSON', async () => {
    const event = makeEvent(validAccount);
    event.body = 'not-json{';
    const res = await handler(event, {} as any, () => {}) as any;

    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.errorCode).toBe('VALIDATION_ERROR');
    expect(body.message).toContain('Invalid JSON');
  });

  it('returns 400 when required field "name" is missing', async () => {
    const { name, ...noName } = validAccount;
    const res = await handler(makeEvent(noName), {} as any, () => {}) as any;

    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.errorCode).toBe('VALIDATION_ERROR');
  });

  it('returns 400 when required field "broker" is missing', async () => {
    const { broker, ...noBroker } = validAccount;
    const res = await handler(makeEvent(noBroker), {} as any, () => {}) as any;

    expect(res.statusCode).toBe(400);
  });

  it('returns 400 when "type" has an invalid enum value', async () => {
    const bad = { ...validAccount, type: 'invalid-type' };
    const res = await handler(makeEvent(bad), {} as any, () => {}) as any;

    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.errorCode).toBe('VALIDATION_ERROR');
  });

  it('returns 400 when "status" has an invalid enum value', async () => {
    const bad = { ...validAccount, status: 'unknown-status' };
    const res = await handler(makeEvent(bad), {} as any, () => {}) as any;

    expect(res.statusCode).toBe(400);
  });

  it('returns 400 when "currency" is too short', async () => {
    const bad = { ...validAccount, currency: 'US' };
    const res = await handler(makeEvent(bad), {} as any, () => {}) as any;

    expect(res.statusCode).toBe(400);
  });

  it('returns 400 when "balance" is not a number', async () => {
    const bad = { ...validAccount, balance: 'not-a-number' };
    const res = await handler(makeEvent(bad), {} as any, () => {}) as any;

    expect(res.statusCode).toBe(400);
  });

  // ── DynamoDB errors ─────────────────────────────────────────

  it('returns 500 when DynamoDB write fails', async () => {
    ddbMock.on(PutCommand).rejects(new Error('DynamoDB error'));

    const res = await handler(makeEvent(validAccount), {} as any, () => {}) as any;

    expect(res.statusCode).toBe(500);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(false);
    expect(body.errorCode).toBe('INTERNAL_ERROR');
  });
});
