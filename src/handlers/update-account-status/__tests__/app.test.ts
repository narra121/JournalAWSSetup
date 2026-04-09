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
    version: '2.0', routeKey: 'PATCH /accounts/{accountId}/status', rawPath: `/accounts/${accountId}/status`, rawQueryString: '',
    headers: { authorization: `Bearer ${makeJwt('user-1')}`, ...((overrides as any).headers || {}) },
    pathParameters: { accountId },
    requestContext: {
      accountId: '123', apiId: 'api', domainName: 'api.example.com', domainPrefix: 'api',
      http: { method: 'PATCH', path: `/accounts/${accountId}/status`, protocol: 'HTTP/1.1', sourceIp: '127.0.0.1', userAgent: 'test' },
      requestId: 'req-1', routeKey: 'PATCH /accounts/{accountId}/status', stage: '$default',
      time: '01/Jan/2024:00:00:00 +0000', timeEpoch: 0,
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
    isBase64Encoded: false,
    ...overrides,
  } as unknown as APIGatewayProxyEventV2;
}

const existingAccount = { userId: 'user-1', accountId: 'acc-1', name: 'Test', status: 'active' };

beforeEach(() => {
  ddbMock.reset();
  ddbMock.on(GetCommand).resolves({ Item: { ...existingAccount } });
  ddbMock.on(UpdateCommand).resolves({ Attributes: { ...existingAccount, status: 'breached' } });
});

describe('update-account-status handler', () => {
  it('updates status and returns 200', async () => {
    const res = await handler(makeEvent('acc-1', { status: 'breached' }), {} as any, () => {}) as any;
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(true);
  });

  it.each(['active', 'breached', 'passed', 'withdrawn', 'inactive'])('accepts valid status: %s', async (status) => {
    const res = await handler(makeEvent('acc-1', { status }), {} as any, () => {}) as any;
    expect(res.statusCode).toBe(200);
  });

  it('returns 401 when unauthorized', async () => {
    const event = makeEvent('acc-1', { status: 'active' });
    event.headers = {};
    const res = await handler(event, {} as any, () => {}) as any;
    expect(res.statusCode).toBe(401);
  });

  it('returns 400 when accountId is missing', async () => {
    const event = makeEvent('acc-1', { status: 'active' });
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
    const event = makeEvent('acc-1', {});
    event.body = '{bad}';
    const res = await handler(event, {} as any, () => {}) as any;
    expect(res.statusCode).toBe(400);
  });

  it('returns 400 for invalid status value', async () => {
    const res = await handler(makeEvent('acc-1', { status: 'unknown-status' }), {} as any, () => {}) as any;
    expect(res.statusCode).toBe(400);
  });

  it('returns 400 when status is missing', async () => {
    const res = await handler(makeEvent('acc-1', { name: 'not-status' }), {} as any, () => {}) as any;
    expect(res.statusCode).toBe(400);
  });

  it('returns 404 when account does not exist', async () => {
    ddbMock.on(GetCommand).resolves({ Item: undefined });
    const res = await handler(makeEvent('acc-nonexistent', { status: 'active' }), {} as any, () => {}) as any;
    expect(res.statusCode).toBe(404);
  });

  it('returns 500 when DynamoDB fails', async () => {
    ddbMock.on(UpdateCommand).rejects(new Error('DDB error'));
    const res = await handler(makeEvent('acc-1', { status: 'breached' }), {} as any, () => {}) as any;
    expect(res.statusCode).toBe(500);
  });
});
