import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { CognitoIdentityProviderClient, InitiateAuthCommand } from '@aws-sdk/client-cognito-identity-provider';
import type { APIGatewayProxyEventV2 } from 'aws-lambda';

vi.stubEnv('USER_POOL_CLIENT_ID', 'test-client-id');

const cognitoMock = mockClient(CognitoIdentityProviderClient);

const { handler } = await import('../app.ts');

// ─── Helpers ────────────────────────────────────────────────────

function makeEvent(body: any): APIGatewayProxyEventV2 {
  return {
    version: '2.0',
    routeKey: 'POST /auth/refresh',
    rawPath: '/auth/refresh',
    rawQueryString: '',
    headers: {},
    requestContext: {
      accountId: '123', apiId: 'api', domainName: 'api.example.com', domainPrefix: 'api',
      http: { method: 'POST', path: '/auth/refresh', protocol: 'HTTP/1.1', sourceIp: '127.0.0.1', userAgent: 'test' },
      requestId: 'req-1', routeKey: 'POST /auth/refresh', stage: '$default',
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

describe('auth-refresh handler', () => {
  it('refreshes tokens and returns 200', async () => {
    cognitoMock.on(InitiateAuthCommand).resolves({
      AuthenticationResult: {
        IdToken: 'new-id-token',
        AccessToken: 'new-access-token',
        ExpiresIn: 3600,
        TokenType: 'Bearer',
      },
    });

    const res = await handler(makeEvent({ refreshToken: 'valid-refresh-token' }), {} as any, () => {}) as any;

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(true);
    expect(body.data.IdToken).toBe('new-id-token');
    expect(body.data.AccessToken).toBe('new-access-token');
    expect(body.data.ExpiresIn).toBe(3600);
  });

  it('calls Cognito with REFRESH_TOKEN_AUTH flow', async () => {
    cognitoMock.on(InitiateAuthCommand).resolves({
      AuthenticationResult: { IdToken: 'x', AccessToken: 'x', ExpiresIn: 1, TokenType: 'Bearer' },
    });

    await handler(makeEvent({ refreshToken: 'my-token' }), {} as any, () => {});

    const calls = cognitoMock.commandCalls(InitiateAuthCommand);
    expect(calls).toHaveLength(1);
    expect(calls[0].args[0].input.AuthFlow).toBe('REFRESH_TOKEN_AUTH');
    expect(calls[0].args[0].input.AuthParameters?.REFRESH_TOKEN).toBe('my-token');
  });

  it('returns 400 when body is missing', async () => {
    const event = makeEvent(undefined);
    event.body = undefined;
    const res = await handler(event, {} as any, () => {}) as any;

    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).errorCode).toBe('VALIDATION_ERROR');
  });

  it('returns 400 when refreshToken is missing', async () => {
    const res = await handler(makeEvent({ someOtherField: 'value' }), {} as any, () => {}) as any;

    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).errorCode).toBe('VALIDATION_ERROR');
  });

  it('returns 400 when AuthenticationResult is null', async () => {
    cognitoMock.on(InitiateAuthCommand).resolves({ AuthenticationResult: undefined });

    const res = await handler(makeEvent({ refreshToken: 'expired-token' }), {} as any, () => {}) as any;

    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).errorCode).toBe('UNAUTHORIZED');
  });

  it('returns 400 when Cognito rejects the refresh token', async () => {
    cognitoMock.on(InitiateAuthCommand).rejects(new Error('Invalid refresh token'));

    const res = await handler(makeEvent({ refreshToken: 'invalid-token' }), {} as any, () => {}) as any;

    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).errorCode).toBe('UNAUTHORIZED');
  });

  // ── Expired / malformed tokens ──────────────────────────────

  it('returns 400 when refresh token is expired', async () => {
    const error = new Error('Refresh Token has expired');
    (error as any).name = 'NotAuthorizedException';
    cognitoMock.on(InitiateAuthCommand).rejects(error);

    const res = await handler(makeEvent({ refreshToken: 'expired-refresh-token' }), {} as any, () => {}) as any;

    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.errorCode).toBe('UNAUTHORIZED');
    expect(body.message).toContain('expired');
  });

  it('returns 400 when refresh token is malformed', async () => {
    const error = new Error('Invalid Refresh Token');
    (error as any).name = 'NotAuthorizedException';
    cognitoMock.on(InitiateAuthCommand).rejects(error);

    const res = await handler(makeEvent({ refreshToken: 'not.a.real.token' }), {} as any, () => {}) as any;

    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.errorCode).toBe('UNAUTHORIZED');
  });

  it('returns 400 when refreshToken is empty string', async () => {
    const res = await handler(makeEvent({ refreshToken: '' }), {} as any, () => {}) as any;

    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).errorCode).toBe('VALIDATION_ERROR');
  });

  it('returns 400 when refreshToken is null', async () => {
    const res = await handler(makeEvent({ refreshToken: null }), {} as any, () => {}) as any;

    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).errorCode).toBe('VALIDATION_ERROR');
  });

  it('returns 400 when Cognito throws a generic error', async () => {
    cognitoMock.on(InitiateAuthCommand).rejects(new Error('InternalErrorException'));

    const res = await handler(makeEvent({ refreshToken: 'some-token' }), {} as any, () => {}) as any;

    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.errorCode).toBe('UNAUTHORIZED');
  });

  it('returns new access token and id token on valid refresh', async () => {
    cognitoMock.on(InitiateAuthCommand).resolves({
      AuthenticationResult: {
        IdToken: 'fresh-id-token',
        AccessToken: 'fresh-access-token',
        ExpiresIn: 7200,
        TokenType: 'Bearer',
      },
    });

    const res = await handler(makeEvent({ refreshToken: 'valid-token' }), {} as any, () => {}) as any;

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(true);
    expect(body.data.IdToken).toBe('fresh-id-token');
    expect(body.data.AccessToken).toBe('fresh-access-token');
    expect(body.data.ExpiresIn).toBe(7200);
    expect(body.data.TokenType).toBe('Bearer');
    expect(body.message).toBe('Token refreshed');
  });

  it('uses the correct CLIENT_ID from environment', async () => {
    cognitoMock.on(InitiateAuthCommand).resolves({
      AuthenticationResult: { IdToken: 'x', AccessToken: 'x', ExpiresIn: 1, TokenType: 'Bearer' },
    });

    await handler(makeEvent({ refreshToken: 'my-token' }), {} as any, () => {});

    const calls = cognitoMock.commandCalls(InitiateAuthCommand);
    expect(calls[0].args[0].input.ClientId).toBe('test-client-id');
  });

  it('returns 400 when body is not valid JSON', async () => {
    const event = makeEvent({ refreshToken: 'x' });
    event.body = '{not-valid-json';
    const res = await handler(event, {} as any, () => {}) as any;

    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).errorCode).toBe('UNAUTHORIZED');
  });
});
