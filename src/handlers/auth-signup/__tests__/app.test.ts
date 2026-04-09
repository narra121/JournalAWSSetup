import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBDocumentClient, GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
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
  // Rate limit defaults: allow
  ddbMock.on(GetCommand).resolves({ Item: undefined });
  ddbMock.on(PutCommand).resolves({});
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
    ddbMock.on(GetCommand).resolves({ Item: { key: 'signup:test@example.com', count: 5, ttl: Math.floor(Date.now() / 1000) + 3600 } });

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
});
