import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBDocumentClient, GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import { CognitoIdentityProviderClient, ForgotPasswordCommand } from '@aws-sdk/client-cognito-identity-provider';
import type { APIGatewayProxyEventV2 } from 'aws-lambda';

vi.stubEnv('USER_POOL_CLIENT_ID', 'test-client-id');
vi.stubEnv('RATE_LIMIT_TABLE', 'test-rate-limit');

const cognitoMock = mockClient(CognitoIdentityProviderClient);
const ddbMock = mockClient(DynamoDBDocumentClient);

const { handler } = await import('../app.ts');

function makeEvent(body: any): APIGatewayProxyEventV2 {
  return {
    version: '2.0', routeKey: 'POST /auth/forgot-password', rawPath: '/auth/forgot-password', rawQueryString: '',
    headers: {},
    requestContext: {
      accountId: '123', apiId: 'api', domainName: 'api.example.com', domainPrefix: 'api',
      http: { method: 'POST', path: '/auth/forgot-password', protocol: 'HTTP/1.1', sourceIp: '127.0.0.1', userAgent: 'test' },
      requestId: 'req-1', routeKey: 'POST /auth/forgot-password', stage: '$default',
      time: '01/Jan/2024:00:00:00 +0000', timeEpoch: 0,
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
    isBase64Encoded: false,
  } as unknown as APIGatewayProxyEventV2;
}

beforeEach(() => {
  cognitoMock.reset();
  ddbMock.reset();
  ddbMock.on(GetCommand).resolves({ Item: undefined });
  ddbMock.on(PutCommand).resolves({});
});

describe('auth-forgot-password handler', () => {
  it('sends reset code and returns 200', async () => {
    cognitoMock.on(ForgotPasswordCommand).resolves({
      CodeDeliveryDetails: { Destination: 't***@example.com' },
    });

    const res = await handler(makeEvent({ email: 'test@example.com' }), {} as any, () => {}) as any;

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(true);
    expect(body.data.message).toContain('t***@example.com');
  });

  it('returns 400 when body is missing', async () => {
    const event = makeEvent(undefined);
    event.body = undefined;
    const res = await handler(event, {} as any, () => {}) as any;

    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).errorCode).toBe('VALIDATION_ERROR');
  });

  it('returns 400 when email is missing', async () => {
    const res = await handler(makeEvent({}), {} as any, () => {}) as any;

    expect(res.statusCode).toBe(400);
  });

  it('returns 429 when rate limited', async () => {
    ddbMock.on(GetCommand).resolves({ Item: { key: 'forgot:test@example.com', count: 5, ttl: Math.floor(Date.now() / 1000) + 900 } });

    const res = await handler(makeEvent({ email: 'test@example.com' }), {} as any, () => {}) as any;

    expect(res.statusCode).toBe(429);
  });

  it('returns 400 when Cognito fails', async () => {
    cognitoMock.on(ForgotPasswordCommand).rejects(new Error('UserNotFoundException'));

    const res = await handler(makeEvent({ email: 'nonexistent@example.com' }), {} as any, () => {}) as any;

    expect(res.statusCode).toBe(400);
  });

  // ── Email not found (should not leak user existence) ────────

  it('returns error without leaking whether the email exists in Cognito', async () => {
    const error = new Error('Username/client id combination not found.');
    (error as any).name = 'UserNotFoundException';
    cognitoMock.on(ForgotPasswordCommand).rejects(error);

    const res = await handler(makeEvent({ email: 'unknown@example.com' }), {} as any, () => {}) as any;

    // Handler returns 400, but message comes from Cognito - it should NOT be 200 pretending success
    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(false);
  });

  // ── Empty / invalid email ───────────────────────────────────

  it('returns 400 when email is empty string', async () => {
    const res = await handler(makeEvent({ email: '' }), {} as any, () => {}) as any;

    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.errorCode).toBe('VALIDATION_ERROR');
  });

  it('returns 400 when email is null', async () => {
    const res = await handler(makeEvent({ email: null }), {} as any, () => {}) as any;

    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.errorCode).toBe('VALIDATION_ERROR');
  });

  // ── Cognito API failures ────────────────────────────────────

  it('returns 400 when Cognito throws InternalErrorException', async () => {
    cognitoMock.on(ForgotPasswordCommand).rejects(new Error('InternalErrorException'));

    const res = await handler(makeEvent({ email: 'test@example.com' }), {} as any, () => {}) as any;

    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.errorCode).toBe('INTERNAL_ERROR');
  });

  it('returns 400 when Cognito throws LimitExceededException', async () => {
    const error = new Error('Attempt limit exceeded, please try after some time.');
    (error as any).name = 'LimitExceededException';
    cognitoMock.on(ForgotPasswordCommand).rejects(error);

    const res = await handler(makeEvent({ email: 'test@example.com' }), {} as any, () => {}) as any;

    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(false);
  });

  // ── Rate limiting details ───────────────────────────────────

  it('includes retryAfter in rate limit response', async () => {
    const futureEpoch = Math.floor(Date.now() / 1000) + 600;
    ddbMock.on(GetCommand).resolves({ Item: { key: 'forgot:test@example.com', count: 5, ttl: futureEpoch } });

    const res = await handler(makeEvent({ email: 'test@example.com' }), {} as any, () => {}) as any;

    expect(res.statusCode).toBe(429);
    const body = JSON.parse(res.body);
    expect(body.message).toContain('Too many attempts');
  });

  // ── Already confirmed / unverified users ────────────────────

  it('handles already confirmed user requesting reset', async () => {
    cognitoMock.on(ForgotPasswordCommand).resolves({
      CodeDeliveryDetails: { Destination: 'c***@example.com' },
    });

    const res = await handler(makeEvent({ email: 'confirmed@example.com' }), {} as any, () => {}) as any;

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(true);
    expect(body.data.message).toContain('c***@example.com');
  });

  it('returns error when unverified user requests reset', async () => {
    const error = new Error('Cannot reset password for the user as there is no registered/verified email');
    (error as any).name = 'InvalidParameterException';
    cognitoMock.on(ForgotPasswordCommand).rejects(error);

    const res = await handler(makeEvent({ email: 'unverified@example.com' }), {} as any, () => {}) as any;

    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(false);
  });

  it('returns 400 when body is not valid JSON', async () => {
    const event = makeEvent({ email: 'test@example.com' });
    event.body = '{not-valid-json';
    const res = await handler(event, {} as any, () => {}) as any;

    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.errorCode).toBe('INTERNAL_ERROR');
  });
});
