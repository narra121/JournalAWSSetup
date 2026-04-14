import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { CognitoIdentityProviderClient, ConfirmSignUpCommand } from '@aws-sdk/client-cognito-identity-provider';
import type { APIGatewayProxyEventV2 } from 'aws-lambda';

vi.stubEnv('USER_POOL_CLIENT_ID', 'test-client-id');

const cognitoMock = mockClient(CognitoIdentityProviderClient);

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
});

describe('auth-confirm-signup handler', () => {
  // ── Success ─────────────────────────────────────────────────

  it('confirms signup and returns 200', async () => {
    cognitoMock.on(ConfirmSignUpCommand).resolves({});

    const res = await handler(makeEvent({ email: 'test@example.com', code: '123456' }), {} as any, () => {}) as any;

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(true);
    expect(body.data.confirmed).toBe(true);
  });

  it('calls ConfirmSignUpCommand with correct params', async () => {
    cognitoMock.on(ConfirmSignUpCommand).resolves({});

    await handler(makeEvent({ email: 'test@example.com', code: '123456' }), {} as any, () => {});

    const calls = cognitoMock.commandCalls(ConfirmSignUpCommand);
    expect(calls).toHaveLength(1);
    expect(calls[0].args[0].input.ClientId).toBe('test-client-id');
    expect(calls[0].args[0].input.Username).toBe('test@example.com');
    expect(calls[0].args[0].input.ConfirmationCode).toBe('123456');
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

  // ── Additional Cognito error cases ──────────────────────────

  it('returns 400 with error name ExpiredCodeException', async () => {
    const error = new Error('Invalid code provided, please request a code again.');
    (error as any).name = 'ExpiredCodeException';
    cognitoMock.on(ConfirmSignUpCommand).rejects(error);

    const res = await handler(makeEvent({ email: 'test@example.com', code: '000000' }), {} as any, () => {}) as any;

    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(false);
    expect(body.message).toContain('code');
  });

  it('returns 400 with CodeMismatchException error name', async () => {
    const error = new Error('Invalid verification code provided, please try again.');
    (error as any).name = 'CodeMismatchException';
    cognitoMock.on(ConfirmSignUpCommand).rejects(error);

    const res = await handler(makeEvent({ email: 'test@example.com', code: '999999' }), {} as any, () => {}) as any;

    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(false);
  });

  it('returns 400 when user is already confirmed (NotAuthorizedException)', async () => {
    const error = new Error('User cannot be confirmed. Current status is CONFIRMED');
    (error as any).name = 'NotAuthorizedException';
    cognitoMock.on(ConfirmSignUpCommand).rejects(error);

    const res = await handler(makeEvent({ email: 'confirmed@example.com', code: '123456' }), {} as any, () => {}) as any;

    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(false);
  });

  // ── Validation edge cases ───────────────────────────────────

  it('returns 400 when email is empty string', async () => {
    const res = await handler(makeEvent({ email: '', code: '123456' }), {} as any, () => {}) as any;

    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.errorCode).toBe('VALIDATION_ERROR');
  });

  it('returns 400 when code is empty string', async () => {
    const res = await handler(makeEvent({ email: 'test@example.com', code: '' }), {} as any, () => {}) as any;

    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.errorCode).toBe('VALIDATION_ERROR');
  });

  it('returns 400 when body is not valid JSON', async () => {
    const event = makeEvent({ email: 'test@example.com', code: '123456' });
    event.body = '{not-valid-json';
    const res = await handler(event, {} as any, () => {}) as any;

    expect(res.statusCode).toBe(400);
  });
});
