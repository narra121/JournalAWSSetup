import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBDocumentClient, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { CognitoIdentityProviderClient, ConfirmForgotPasswordCommand } from '@aws-sdk/client-cognito-identity-provider';
import type { APIGatewayProxyEventV2 } from 'aws-lambda';

vi.stubEnv('USER_POOL_CLIENT_ID', 'test-client-id');
vi.stubEnv('RATE_LIMIT_TABLE', 'test-rate-limit');

const cognitoMock = mockClient(CognitoIdentityProviderClient);
const ddbMock = mockClient(DynamoDBDocumentClient);

const { handler } = await import('../app.ts');

function makeEvent(body: any): APIGatewayProxyEventV2 {
  return {
    version: '2.0', routeKey: 'POST /auth/confirm-forgot-password', rawPath: '/auth/confirm-forgot-password', rawQueryString: '',
    headers: {},
    requestContext: {
      accountId: '123', apiId: 'api', domainName: 'api.example.com', domainPrefix: 'api',
      http: { method: 'POST', path: '/auth/confirm-forgot-password', protocol: 'HTTP/1.1', sourceIp: '127.0.0.1', userAgent: 'test' },
      requestId: 'req-1', routeKey: 'POST /auth/confirm-forgot-password', stage: '$default',
      time: '01/Jan/2024:00:00:00 +0000', timeEpoch: 0,
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
    isBase64Encoded: false,
  } as unknown as APIGatewayProxyEventV2;
}

beforeEach(() => {
  cognitoMock.reset();
  ddbMock.reset();
  // Rate limit defaults: allow (count=1, fresh ttl)
  ddbMock.on(UpdateCommand).resolves({ Attributes: { key: 'test', count: 1, ttl: Math.floor(Date.now() / 1000) + 900 } });
});

describe('auth-confirm-forgot-password handler', () => {
  it('confirms password reset and returns 200', async () => {
    cognitoMock.on(ConfirmForgotPasswordCommand).resolves({});

    const res = await handler(makeEvent({ email: 'test@example.com', code: '123456', newPassword: 'NewPass1!' }), {} as any, () => {}) as any;

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(true);
    expect(body.data.message).toContain('Password reset confirmed');
  });

  it('returns 400 when body is missing', async () => {
    const event = makeEvent(undefined);
    event.body = undefined;
    const res = await handler(event, {} as any, () => {}) as any;

    expect(res.statusCode).toBe(400);
  });

  it('returns 400 when email is missing', async () => {
    const res = await handler(makeEvent({ code: '123456', newPassword: 'NewPass1!' }), {} as any, () => {}) as any;
    expect(res.statusCode).toBe(400);
  });

  it('returns 400 when code is missing', async () => {
    const res = await handler(makeEvent({ email: 'test@example.com', newPassword: 'NewPass1!' }), {} as any, () => {}) as any;
    expect(res.statusCode).toBe(400);
  });

  it('returns 400 when newPassword is missing', async () => {
    const res = await handler(makeEvent({ email: 'test@example.com', code: '123456' }), {} as any, () => {}) as any;
    expect(res.statusCode).toBe(400);
  });

  it('returns 400 when newPassword is too short (< 8 chars)', async () => {
    const res = await handler(makeEvent({ email: 'test@example.com', code: '123456', newPassword: 'short' }), {} as any, () => {}) as any;

    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).message).toContain('8-128');
  });

  it('returns 400 when newPassword is too long (> 128 chars)', async () => {
    const res = await handler(makeEvent({ email: 'test@example.com', code: '123456', newPassword: 'A'.repeat(129) }), {} as any, () => {}) as any;

    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).message).toContain('8-128');
  });

  it('returns 429 when rate limited', async () => {
    ddbMock.on(UpdateCommand).resolves({ Attributes: { key: 'forgot-confirm:test@example.com', count: 11, ttl: Math.floor(Date.now() / 1000) + 900 } });

    const res = await handler(makeEvent({ email: 'test@example.com', code: '123456', newPassword: 'NewPass1!' }), {} as any, () => {}) as any;

    expect(res.statusCode).toBe(429);
  });

  it('returns 400 when Cognito rejects the code', async () => {
    cognitoMock.on(ConfirmForgotPasswordCommand).rejects(new Error('CodeMismatchException'));

    const res = await handler(makeEvent({ email: 'test@example.com', code: 'wrong', newPassword: 'NewPass1!' }), {} as any, () => {}) as any;

    expect(res.statusCode).toBe(400);
  });
});
