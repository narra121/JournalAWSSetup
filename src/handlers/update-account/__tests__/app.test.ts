import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBDocumentClient, GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import type { APIGatewayProxyEventV2 } from 'aws-lambda';

vi.stubEnv('ACCOUNTS_TABLE', 'test-accounts');

const ddbMock = mockClient(DynamoDBDocumentClient);

const { handler } = await import('../app.ts');

function makeJwt(sub: string): string {
  const header = btoa(JSON.stringify({ alg: 'RS256' }));
  const payload = btoa(JSON.stringify({ sub }));
  return `${header}.${payload}.sig`;
}

function makeEvent(accountId: string, body: any, overrides: Partial<APIGatewayProxyEventV2> = {}): APIGatewayProxyEventV2 {
  return {
    version: '2.0', routeKey: 'PUT /accounts/{accountId}', rawPath: `/accounts/${accountId}`, rawQueryString: '',
    headers: { authorization: `Bearer ${makeJwt('user-1')}`, ...((overrides as any).headers || {}) },
    pathParameters: { accountId },
    requestContext: {
      accountId: '123', apiId: 'api', domainName: 'api.example.com', domainPrefix: 'api',
      http: { method: 'PUT', path: `/accounts/${accountId}`, protocol: 'HTTP/1.1', sourceIp: '127.0.0.1', userAgent: 'test' },
      requestId: 'req-1', routeKey: 'PUT /accounts/{accountId}', stage: '$default',
      time: '01/Jan/2024:00:00:00 +0000', timeEpoch: 0,
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
    isBase64Encoded: false,
    ...overrides,
  } as unknown as APIGatewayProxyEventV2;
}

const existingAccount = { userId: 'user-1', accountId: 'acc-1', name: 'Test Account', broker: 'IB', type: 'personal', status: 'active', balance: 10000 };

beforeEach(() => {
  ddbMock.reset();
  ddbMock.on(GetCommand).resolves({ Item: { ...existingAccount } });
  ddbMock.on(UpdateCommand).resolves({ Attributes: { ...existingAccount, updatedAt: new Date().toISOString() } });
});

describe('update-account handler', () => {
  it('updates account and returns 200', async () => {
    const res = await handler(makeEvent('acc-1', { name: 'Updated Account' }), {} as any, () => {}) as any;

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(true);
    expect(body.data.account).toBeDefined();
  });

  it('returns 401 when unauthorized', async () => {
    const event = makeEvent('acc-1', { name: 'Updated' });
    event.headers = {};
    const res = await handler(event, {} as any, () => {}) as any;
    expect(res.statusCode).toBe(401);
  });

  it('returns 400 when accountId is missing', async () => {
    const event = makeEvent('acc-1', { name: 'Updated' });
    event.pathParameters = {};
    const res = await handler(event, {} as any, () => {}) as any;
    expect(res.statusCode).toBe(400);
  });

  it('returns 400 when body is missing', async () => {
    const event = makeEvent('acc-1', undefined);
    event.body = undefined;
    const res = await handler(event, {} as any, () => {}) as any;
    expect(res.statusCode).toBe(400);
  });

  it('returns 400 for invalid JSON', async () => {
    const event = makeEvent('acc-1', { name: 'test' });
    event.body = 'not-json{';
    const res = await handler(event, {} as any, () => {}) as any;
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).message).toContain('Invalid JSON');
  });

  it('returns 400 for invalid enum value for type', async () => {
    const res = await handler(makeEvent('acc-1', { type: 'invalid-type' }), {} as any, () => {}) as any;
    expect(res.statusCode).toBe(400);
  });

  it('returns 400 for invalid enum value for status', async () => {
    const res = await handler(makeEvent('acc-1', { status: 'invalid-status' }), {} as any, () => {}) as any;
    expect(res.statusCode).toBe(400);
  });

  it('returns 400 when currency is too short', async () => {
    const res = await handler(makeEvent('acc-1', { currency: 'AB' }), {} as any, () => {}) as any;
    expect(res.statusCode).toBe(400);
  });

  it('returns 404 when account does not exist', async () => {
    ddbMock.on(GetCommand).resolves({ Item: undefined });
    const res = await handler(makeEvent('acc-nonexistent', { name: 'Updated' }), {} as any, () => {}) as any;
    expect(res.statusCode).toBe(404);
  });

  it('returns 500 when DynamoDB fails', async () => {
    ddbMock.on(GetCommand).resolves({ Item: { ...existingAccount } });
    ddbMock.on(UpdateCommand).rejects(new Error('DynamoDB error'));
    const res = await handler(makeEvent('acc-1', { name: 'Updated' }), {} as any, () => {}) as any;
    expect(res.statusCode).toBe(500);
  });
});
