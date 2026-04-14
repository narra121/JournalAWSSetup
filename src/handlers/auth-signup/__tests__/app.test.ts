import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBDocumentClient, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { CognitoIdentityProviderClient, SignUpCommand, ResendConfirmationCodeCommand } from '@aws-sdk/client-cognito-identity-provider';
import type { APIGatewayProxyEventV2 } from 'aws-lambda';

vi.stubEnv('USER_POOL_CLIENT_ID', 'test-client-id');
vi.stubEnv('RATE_LIMIT_TABLE', 'test-rate-limit');

const cognitoMock = mockClient(CognitoIdentityProviderClient);
const ddbMock = mockClient(DynamoDBDocumentClient);

const { handler } = await import('../app.ts');

// ─── Helpers ────────────────────────────────────────────────────

function makeEvent(body: any): APIGatewayProxyEventV2 {
  return {
    version: '2.0',
    routeKey: 'POST /auth/signup',
    rawPath: '/auth/signup',
    rawQueryString: '',
    headers: {},
    requestContext: {
      accountId: '123', apiId: 'api', domainName: 'api.example.com', domainPrefix: 'api',
      http: { method: 'POST', path: '/auth/signup', protocol: 'HTTP/1.1', sourceIp: '127.0.0.1', userAgent: 'test' },
      requestId: 'req-1', routeKey: 'POST /auth/signup', stage: '$default',
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
  // Rate limit defaults: allow (count=1, fresh ttl)
  ddbMock.on(UpdateCommand).resolves({ Attributes: { key: 'test', count: 1, ttl: Math.floor(Date.now() / 1000) + 3600 } });
});

describe('auth-signup handler', () => {
  // ── Success ─────────────────────────────────────────────────

  it('signs up a user and returns 200', async () => {
    cognitoMock.on(SignUpCommand).resolves({ UserSub: 'user-sub-123' });

    const res = await handler(makeEvent({ email: 'test@example.com', password: 'Password1!', name: 'Test User' }), {} as any, () => {}) as any;

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(true);
    expect(body.data.user.id).toBe('user-sub-123');
    expect(body.data.user.email).toBe('test@example.com');
    expect(body.data.user.name).toBe('Test User');
  });

  it('calls Cognito SignUpCommand with correct params', async () => {
    cognitoMock.on(SignUpCommand).resolves({ UserSub: 'user-sub-123' });

    await handler(makeEvent({ email: 'test@example.com', password: 'Password1!', name: 'Test User' }), {} as any, () => {});

    const calls = cognitoMock.commandCalls(SignUpCommand);
    expect(calls).toHaveLength(1);
    expect(calls[0].args[0].input.ClientId).toBe('test-client-id');
    expect(calls[0].args[0].input.Username).toBe('test@example.com');
  });

  // ── Validation errors ───────────────────────────────────────

  it('returns 400 when body is missing', async () => {
    const event = makeEvent(undefined);
    event.body = undefined;
    const res = await handler(event, {} as any, () => {}) as any;

    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.errorCode).toBe('VALIDATION_ERROR');
    expect(body.message).toContain('Missing body');
  });

  it('returns 400 when email is missing', async () => {
    const res = await handler(makeEvent({ password: 'Password1!', name: 'Test' }), {} as any, () => {}) as any;

    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.errorCode).toBe('VALIDATION_ERROR');
  });

  it('returns 400 when password is missing', async () => {
    const res = await handler(makeEvent({ email: 'test@example.com', name: 'Test' }), {} as any, () => {}) as any;

    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.errorCode).toBe('VALIDATION_ERROR');
  });

  it('returns 400 when name is missing', async () => {
    const res = await handler(makeEvent({ email: 'test@example.com', password: 'Password1!' }), {} as any, () => {}) as any;

    expect(res.statusCode).toBe(400);
  });

  it('returns 400 when password is too short (< 8 chars)', async () => {
    const res = await handler(makeEvent({ email: 'test@example.com', password: 'short', name: 'Test' }), {} as any, () => {}) as any;

    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.message).toContain('8-128');
  });

  it('returns 400 when password is too long (> 128 chars)', async () => {
    const longPassword = 'A'.repeat(129);
    const res = await handler(makeEvent({ email: 'test@example.com', password: longPassword, name: 'Test' }), {} as any, () => {}) as any;

    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.message).toContain('8-128');
  });

  // ── Rate limiting ───────────────────────────────────────────

  it('returns 429 when rate limited', async () => {
    ddbMock.on(UpdateCommand).resolves({ Attributes: { key: 'signup:test@example.com', count: 6, ttl: Math.floor(Date.now() / 1000) + 3600 } });

    const res = await handler(makeEvent({ email: 'test@example.com', password: 'Password1!', name: 'Test' }), {} as any, () => {}) as any;

    expect(res.statusCode).toBe(429);
    const body = JSON.parse(res.body);
    expect(body.message).toContain('Too many attempts');
  });

  // ── UsernameExistsException (resend code) ───────────────────

  it('resends confirmation code when user exists but is unconfirmed', async () => {
    const error = new Error('User already exists');
    (error as any).name = 'UsernameExistsException';
    cognitoMock.on(SignUpCommand).rejects(error);
    cognitoMock.on(ResendConfirmationCodeCommand).resolves({});

    const res = await handler(makeEvent({ email: 'test@example.com', password: 'Password1!', name: 'Test' }), {} as any, () => {}) as any;

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.data.resent).toBe(true);
  });

  it('returns 400 USER_EXISTS when resend fails', async () => {
    const error = new Error('User already exists');
    (error as any).name = 'UsernameExistsException';
    cognitoMock.on(SignUpCommand).rejects(error);
    cognitoMock.on(ResendConfirmationCodeCommand).rejects(new Error('Resend failed'));

    const res = await handler(makeEvent({ email: 'test@example.com', password: 'Password1!', name: 'Test' }), {} as any, () => {}) as any;

    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.errorCode).toBe('USER_EXISTS');
  });

  // ── Cognito errors ──────────────────────────────────────────

  it('returns 400 for generic Cognito errors', async () => {
    cognitoMock.on(SignUpCommand).rejects(new Error('InvalidParameterException'));

    const res = await handler(makeEvent({ email: 'test@example.com', password: 'Password1!', name: 'Test' }), {} as any, () => {}) as any;

    expect(res.statusCode).toBe(400);
  });

  // ── Additional Cognito error codes ──────────────────────────

  it('returns 400 when Cognito rejects weak password (InvalidPasswordException)', async () => {
    const error = new Error('Password does not conform to policy: Password not long enough');
    (error as any).name = 'InvalidPasswordException';
    cognitoMock.on(SignUpCommand).rejects(error);

    const res = await handler(makeEvent({ email: 'test@example.com', password: 'Abcdefg8', name: 'Test' }), {} as any, () => {}) as any;

    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.message).toContain('Password');
  });

  it('returns 400 when Cognito throws InvalidParameterException for invalid email', async () => {
    const error = new Error('Invalid email address format.');
    (error as any).name = 'InvalidParameterException';
    cognitoMock.on(SignUpCommand).rejects(error);

    const res = await handler(makeEvent({ email: 'not-an-email', password: 'Password1!', name: 'Test' }), {} as any, () => {}) as any;

    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(false);
  });

  // ── Edge cases ──────────────────────────────────────────────

  it('returns 400 when all required fields are missing', async () => {
    const res = await handler(makeEvent({}), {} as any, () => {}) as any;

    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.errorCode).toBe('VALIDATION_ERROR');
  });

  it('accepts password at exactly 8 characters', async () => {
    cognitoMock.on(SignUpCommand).resolves({ UserSub: 'user-sub-exact' });

    const res = await handler(makeEvent({ email: 'test@example.com', password: 'Abcdefg8', name: 'Test' }), {} as any, () => {}) as any;

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.data.user.id).toBe('user-sub-exact');
  });

  it('accepts password at exactly 128 characters', async () => {
    const password128 = 'A'.repeat(128);
    cognitoMock.on(SignUpCommand).resolves({ UserSub: 'user-sub-max' });

    const res = await handler(makeEvent({ email: 'test@example.com', password: password128, name: 'Test' }), {} as any, () => {}) as any;

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.data.user.id).toBe('user-sub-max');
  });

  it('handles very long email gracefully', async () => {
    const longEmail = 'a'.repeat(200) + '@example.com';
    cognitoMock.on(SignUpCommand).resolves({ UserSub: 'user-sub-long' });

    const res = await handler(makeEvent({ email: longEmail, password: 'Password1!', name: 'Test' }), {} as any, () => {}) as any;

    // Handler passes it to Cognito which would reject or accept
    expect([200, 400]).toContain(res.statusCode);
  });

  it('returns 400 when body is not valid JSON', async () => {
    const event = makeEvent({ email: 'test@example.com', password: 'Password1!', name: 'Test' });
    event.body = '{not-valid-json';
    const res = await handler(event, {} as any, () => {}) as any;

    expect(res.statusCode).toBe(400);
  });
});
