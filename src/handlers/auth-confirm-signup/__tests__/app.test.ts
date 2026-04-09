import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBDocumentClient, BatchWriteCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import { CognitoIdentityProviderClient, ConfirmSignUpCommand, AdminGetUserCommand } from '@aws-sdk/client-cognito-identity-provider';
import type { APIGatewayProxyEventV2 } from 'aws-lambda';

vi.stubEnv('USER_POOL_CLIENT_ID', 'test-client-id');
vi.stubEnv('USER_POOL_ID', 'test-pool-id');
vi.stubEnv('RULES_TABLE', 'test-rules');
vi.stubEnv('SAVED_OPTIONS_TABLE', 'test-saved-options');

const cognitoMock = mockClient(CognitoIdentityProviderClient);
const ddbMock = mockClient(DynamoDBDocumentClient);

const { handler } = await import('../app.ts');

// ─── Helpers ────────────────────────────────────────────────────

function makeEvent(body: any): APIGatewayProxyEventV2 {
  return {
    version: '2.0',
    routeKey: 'POST /auth/confirm-signup',
    rawPath: '/auth/confirm-signup',
    rawQueryString: '',
    headers: {},
    requestContext: {
      accountId: '123', apiId: 'api', domainName: 'api.example.com', domainPrefix: 'api',
      http: { method: 'POST', path: '/auth/confirm-signup', protocol: 'HTTP/1.1', sourceIp: '127.0.0.1', userAgent: 'test' },
      requestId: 'req-1', routeKey: 'POST /auth/confirm-signup', stage: '$default',
      time: '01/Jan/2024:00:00:00 +0000', timeEpoch: 0,
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
    isBase64Encoded: false,
  } as unknown as APIGatewayProxyEventV2;
}

// ─── Tests ──────────────────────────────────────────────────────

beforeEach(() => {
  cognitoMock.reset();
  ddbMock.reset();
  ddbMock.on(BatchWriteCommand).resolves({ UnprocessedItems: {} });
  ddbMock.on(PutCommand).resolves({});
});

describe('auth-confirm-signup handler', () => {
  // ── Success ─────────────────────────────────────────────────

  it('confirms signup and returns 200', async () => {
    cognitoMock.on(ConfirmSignUpCommand).resolves({});
    cognitoMock.on(AdminGetUserCommand).resolves({
      UserAttributes: [{ Name: 'sub', Value: 'user-sub-123' }],
    });

    const res = await handler(makeEvent({ email: 'test@example.com', code: '123456' }), {} as any, () => {}) as any;

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(true);
    expect(body.data.confirmed).toBe(true);
  });

  it('creates default rules after confirmation', async () => {
    cognitoMock.on(ConfirmSignUpCommand).resolves({});
    cognitoMock.on(AdminGetUserCommand).resolves({
      UserAttributes: [{ Name: 'sub', Value: 'user-sub-123' }],
    });

    await handler(makeEvent({ email: 'test@example.com', code: '123456' }), {} as any, () => {});

    const batchCalls = ddbMock.commandCalls(BatchWriteCommand);
    expect(batchCalls.length).toBeGreaterThanOrEqual(1);
    // Should write 6 default rules
    const items = batchCalls[0].args[0].input.RequestItems?.['test-rules'];
    expect(items).toHaveLength(6);
  });

  it('creates default saved options after confirmation', async () => {
    cognitoMock.on(ConfirmSignUpCommand).resolves({});
    cognitoMock.on(AdminGetUserCommand).resolves({
      UserAttributes: [{ Name: 'sub', Value: 'user-sub-123' }],
    });

    await handler(makeEvent({ email: 'test@example.com', code: '123456' }), {} as any, () => {});

    const putCalls = ddbMock.commandCalls(PutCommand);
    expect(putCalls.length).toBeGreaterThanOrEqual(1);
    const savedOptions = putCalls[0].args[0].input.Item;
    expect(savedOptions?.userId).toBe('user-sub-123');
    expect(savedOptions?.strategies).toBeDefined();
  });

  it('succeeds even if default rules creation fails', async () => {
    cognitoMock.on(ConfirmSignUpCommand).resolves({});
    cognitoMock.on(AdminGetUserCommand).rejects(new Error('Admin error'));

    const res = await handler(makeEvent({ email: 'test@example.com', code: '123456' }), {} as any, () => {}) as any;

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.data.confirmed).toBe(true);
  });

  it('succeeds when AdminGetUser returns no sub attribute', async () => {
    cognitoMock.on(ConfirmSignUpCommand).resolves({});
    cognitoMock.on(AdminGetUserCommand).resolves({
      UserAttributes: [{ Name: 'email', Value: 'test@example.com' }],
    });

    const res = await handler(makeEvent({ email: 'test@example.com', code: '123456' }), {} as any, () => {}) as any;

    expect(res.statusCode).toBe(200);
    // No batch writes should happen without a sub
    const batchCalls = ddbMock.commandCalls(BatchWriteCommand);
    expect(batchCalls).toHaveLength(0);
  });

  // ── Validation errors ───────────────────────────────────────

  it('returns 400 when body is missing', async () => {
    const event = makeEvent(undefined);
    event.body = undefined;
    const res = await handler(event, {} as any, () => {}) as any;

    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).errorCode).toBe('VALIDATION_ERROR');
  });

  it('returns 400 when email is missing', async () => {
    const res = await handler(makeEvent({ code: '123456' }), {} as any, () => {}) as any;

    expect(res.statusCode).toBe(400);
  });

  it('returns 400 when code is missing', async () => {
    const res = await handler(makeEvent({ email: 'test@example.com' }), {} as any, () => {}) as any;

    expect(res.statusCode).toBe(400);
  });

  // ── Cognito errors ──────────────────────────────────────────

  it('returns 400 when confirmation code is invalid', async () => {
    cognitoMock.on(ConfirmSignUpCommand).rejects(new Error('CodeMismatchException'));

    const res = await handler(makeEvent({ email: 'test@example.com', code: 'wrong' }), {} as any, () => {}) as any;

    expect(res.statusCode).toBe(400);
  });

  it('returns 400 when confirmation code is expired', async () => {
    cognitoMock.on(ConfirmSignUpCommand).rejects(new Error('ExpiredCodeException'));

    const res = await handler(makeEvent({ email: 'test@example.com', code: '123456' }), {} as any, () => {}) as any;

    expect(res.statusCode).toBe(400);
  });
});
