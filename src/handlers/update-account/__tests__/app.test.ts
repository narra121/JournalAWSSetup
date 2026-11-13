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

  const conditionFailed = (item?: any) => Object.assign(new Error('The conditional request failed'), { name: 'ConditionalCheckFailedException', Item: item });
  const written = () => ddbMock.commandCalls(UpdateCommand)[0].args[0].input;

  it('returns 404 when account does not exist, without creating a stub item (BE-087)', async () => {
    ddbMock.on(UpdateCommand).rejects(conditionFailed());
    const res = await handler(makeEvent('acc-nonexistent', { name: 'Updated' }), {} as any, () => {}) as any;
    expect(res.statusCode).toBe(404);
    expect(written().ConditionExpression).toBe('attribute_exists(accountId)');
    expect(ddbMock.commandCalls(GetCommand)).toHaveLength(0);
  });

  describe('balance (BE-030 / X-007)', () => {
    it('ignores a balance sent by the client', async () => {
      await handler(makeEvent('acc-1', { name: 'N', balance: 1 }), {} as any, () => {});
      const names = Object.values(written().ExpressionAttributeNames as Record<string, string>);
      expect(names).toContain('name');
      expect(names).not.toContain('balance');
    });

    it('a request with only a balance has nothing to update', async () => {
      const res = await handler(makeEvent('acc-1', { balance: 5 }), {} as any, () => {}) as any;
      expect(res.statusCode).toBe(400);
      expect(ddbMock.commandCalls(UpdateCommand)).toHaveLength(0);
    });

    it('changing initialBalance from 10,000 to 20,000 adds the 10,000 difference to the balance in the same update', async () => {
      ddbMock.on(GetCommand).resolves({ Item: { ...existingAccount, initialBalance: 10000 } });
      await handler(makeEvent('acc-1', { initialBalance: 20000 }), {} as any, () => {});
      const input = written();
      expect(input.UpdateExpression).toMatch(/^SET .* ADD #balance :delta$/);
      expect(input.ExpressionAttributeValues).toMatchObject({ ':delta': 10000, ':previous': 10000, ':val0': 20000 });
      expect(input.ConditionExpression).toBe('attribute_exists(accountId) AND #attr0 = :previous');
    });

    it('lowering it subtracts, and an account without a stored initialBalance counts it as 0', async () => {
      ddbMock.on(GetCommand).resolves({ Item: { ...existingAccount, initialBalance: 10000 } });
      await handler(makeEvent('acc-1', { initialBalance: 4000 }), {} as any, () => {});
      expect(written().ExpressionAttributeValues).toMatchObject({ ':delta': -6000 });
      ddbMock.resetHistory();
      ddbMock.on(GetCommand).resolves({ Item: { ...existingAccount } });
      await handler(makeEvent('acc-1', { initialBalance: 500 }), {} as any, () => {});
      expect(written().ExpressionAttributeValues).toMatchObject({ ':delta': 500 });
      expect(written().ConditionExpression).toBe('attribute_exists(accountId) AND attribute_not_exists(#attr0)');
    });

    it('an unchanged initialBalance adds 0, and edits without it never touch the balance', async () => {
      ddbMock.on(GetCommand).resolves({ Item: { ...existingAccount, initialBalance: 10000 } });
      await handler(makeEvent('acc-1', { initialBalance: 10000 }), {} as any, () => {});
      expect(written().ExpressionAttributeValues).toMatchObject({ ':delta': 0 });
      ddbMock.resetHistory();
      await handler(makeEvent('acc-1', { name: 'Only a rename' }), {} as any, () => {});
      expect(written().UpdateExpression).not.toContain('ADD');
      expect(ddbMock.commandCalls(GetCommand)).toHaveLength(0);
    });

    it('404 when the account is not there, 409 when its initial balance changed after the read', async () => {
      ddbMock.on(GetCommand).resolves({ Item: undefined });
      expect(((await handler(makeEvent('acc-1', { initialBalance: 1 }), {} as any, () => {})) as any).statusCode).toBe(404);
      ddbMock.on(GetCommand).resolves({ Item: { initialBalance: 10000 } });
      ddbMock.on(UpdateCommand).rejects(conditionFailed({ initialBalance: 12000 }));
      expect(((await handler(makeEvent('acc-1', { initialBalance: 20000 }), {} as any, () => {})) as any).statusCode).toBe(409);
    });
  });

  it('returns 500 when DynamoDB fails', async () => {
    ddbMock.on(GetCommand).resolves({ Item: { ...existingAccount } });
    ddbMock.on(UpdateCommand).rejects(new Error('DynamoDB error'));
    const res = await handler(makeEvent('acc-1', { name: 'Updated' }), {} as any, () => {}) as any;
    expect(res.statusCode).toBe(500);
  });
});
