import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBDocumentClient, GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import { CognitoIdentityProviderClient, InitiateAuthCommand, GetUserCommand } from '@aws-sdk/client-cognito-identity-provider';
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
    routeKey: 'POST /auth/login',
    rawPath: '/auth/login',
    rawQueryString: '',
    headers: {},
    requestContext: {
      accountId: '123', apiId: 'api', domainName: 'api.example.com', domainPrefix: 'api',
      http: { method: 'POST', path: '/auth/login', protocol: 'HTTP/1.1', sourceIp: '127.0.0.1', userAgent: 'test' },
      requestId: 'req-1', routeKey: 'POST /auth/login', stage: '$default',
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
  ddbMock.on(GetCommand).resolves({ Item: undefined });
  ddbMock.on(PutCommand).resolves({});
});

describe('auth-login handler', () => {
  // ── Success ─────────────────────────────────────────────────

  it('logs in successfully and returns tokens + user', async () => {
    cognitoMock.on(InitiateAuthCommand).resolves({
      AuthenticationResult: {
        IdToken: 'id-token',
        AccessToken: 'access-token',
        RefreshToken: 'refresh-token',
        ExpiresIn: 3600,
        TokenType: 'Bearer',
      },
    });
    cognitoMock.on(GetUserCommand).resolves({
      UserAttributes: [
        { Name: 'sub', Value: 'user-123' },
        { Name: 'name', Value: 'Test User' },
        { Name: 'email', Value: 'test@example.com' },
      ],
    });

    const res = await handler(makeEvent({ email: 'test@example.com', password: 'Password1!' }), {} as any, () => {}) as any;

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(true);
    expect(body.data.IdToken).toBe('id-token');
    expect(body.data.AccessToken).toBe('access-token');
    expect(body.data.RefreshToken).toBe('refresh-token');
    expect(body.data.user.id).toBe('user-123');
    expect(body.data.user.name).toBe('Test User');
    expect(body.data.user.email).toBe('test@example.com');
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
    const res = await handler(makeEvent({ password: 'Password1!' }), {} as any, () => {}) as any;

    expect(res.statusCode).toBe(400);
  });

  it('returns 400 when password is missing', async () => {
    const res = await handler(makeEvent({ email: 'test@example.com' }), {} as any, () => {}) as any;

    expect(res.statusCode).toBe(400);
  });

  // ── Rate limiting ───────────────────────────────────────────

  it('returns 429 when rate limited', async () => {
    ddbMock.on(GetCommand).resolves({ Item: { key: 'login:test@example.com', count: 10, ttl: Math.floor(Date.now() / 1000) + 300 } });

    const res = await handler(makeEvent({ email: 'test@example.com', password: 'Password1!' }), {} as any, () => {}) as any;

    expect(res.statusCode).toBe(429);
  });

  // ── Auth failures ───────────────────────────────────────────

  it('returns 400 when AuthenticationResult is null', async () => {
    cognitoMock.on(InitiateAuthCommand).resolves({ AuthenticationResult: undefined });

    const res = await handler(makeEvent({ email: 'test@example.com', password: 'Password1!' }), {} as any, () => {}) as any;

    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).errorCode).toBe('UNAUTHORIZED');
  });

  it('returns 403 EMAIL_NOT_VERIFIED for UserNotConfirmedException', async () => {
    const error = new Error('User is not confirmed.');
    (error as any).name = 'UserNotConfirmedException';
    cognitoMock.on(InitiateAuthCommand).rejects(error);

    const res = await handler(makeEvent({ email: 'test@example.com', password: 'Password1!' }), {} as any, () => {}) as any;

    expect(res.statusCode).toBe(403);
    const body = JSON.parse(res.body);
    expect(body.errorCode).toBe('EMAIL_NOT_VERIFIED');
  });

  it('returns 400 UNAUTHORIZED for wrong password', async () => {
    const error = new Error('Incorrect username or password.');
    (error as any).name = 'NotAuthorizedException';
    cognitoMock.on(InitiateAuthCommand).rejects(error);

    const res = await handler(makeEvent({ email: 'test@example.com', password: 'wrong' }), {} as any, () => {}) as any;

    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).errorCode).toBe('UNAUTHORIZED');
  });
});
