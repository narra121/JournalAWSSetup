import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { CognitoIdentityProviderClient, AdminUpdateUserAttributesCommand, ListUsersCommand } from '@aws-sdk/client-cognito-identity-provider';
import type { APIGatewayProxyEventV2 } from 'aws-lambda';

vi.stubEnv('USER_POOL_ID', 'us-east-1_TestPool');

const cognitoMock = mockClient(CognitoIdentityProviderClient);

const { handler } = await import('../app.ts');

// ─── Helpers ────────────────────────────────────────────────────

function makeJwt(sub: string, extra: Record<string, string> = {}): string {
  const header = btoa(JSON.stringify({ alg: 'RS256' }));
  const payload = btoa(JSON.stringify({ sub, ...extra }));
  return `${header}.${payload}.sig`;
}

function makeEvent(body: any, overrides: Partial<APIGatewayProxyEventV2> = {}): APIGatewayProxyEventV2 {
  return {
    version: '2.0',
    routeKey: 'PUT /user/profile',
    rawPath: '/user/profile',
    rawQueryString: '',
    headers: {
      authorization: `Bearer ${makeJwt('user-1')}`,
      ...((overrides as any).headers || {}),
    },
    requestContext: {
      accountId: '123',
      apiId: 'api',
      domainName: 'api.example.com',
      domainPrefix: 'api',
      http: { method: 'PUT', path: '/user/profile', protocol: 'HTTP/1.1', sourceIp: '127.0.0.1', userAgent: 'test' },
      requestId: 'req-1',
      routeKey: 'PUT /user/profile',
      stage: '$default',
      time: '01/Jan/2024:00:00:00 +0000',
      timeEpoch: 0,
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
    isBase64Encoded: false,
    ...overrides,
  } as unknown as APIGatewayProxyEventV2;
}

// ─── Tests ──────────────────────────────────────────────────────

beforeEach(() => {
  cognitoMock.reset();
  cognitoMock.on(AdminUpdateUserAttributesCommand).resolves({});
  cognitoMock.on(ListUsersCommand).resolves({ Users: [{ Username: 'Google_999' }] });
});

describe('update-user-profile handler', () => {
  // ── Success ─────────────────────────────────────────────────

  it('updates profile and returns 200', async () => {
    const res = await handler(makeEvent({ name: 'New Name' }), {} as any, () => {}) as any;

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(true);
    expect(body.message).toContain('updated');

    const cognitoCalls = cognitoMock.commandCalls(AdminUpdateUserAttributesCommand);
    expect(cognitoCalls).toHaveLength(1);
    expect(cognitoCalls[0].args[0].input.UserAttributes).toEqual([{ Name: 'name', Value: 'New Name' }]);
  });

  it('returns 500 when Cognito update fails', async () => {
    cognitoMock.on(AdminUpdateUserAttributesCommand).rejects(new Error('Cognito update failed'));

    const res = await handler(makeEvent({ name: 'New Name' }), {} as any, () => {}) as any;

    expect(res.statusCode).toBe(500);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(false);
    expect(body.errorCode).toBe('INTERNAL_ERROR');
  });

  // ── Auth errors ─────────────────────────────────────────────

  it('returns 401 when authorization header is missing', async () => {
    const event = makeEvent({ name: 'New Name' });
    event.headers = {};
    const res = await handler(event, {} as any, () => {}) as any;

    expect(res.statusCode).toBe(401);
    const body = JSON.parse(res.body);
    expect(body.errorCode).toBe('UNAUTHORIZED');
  });

  // ── Validation errors ───────────────────────────────────────

  it('returns 400 when body is missing', async () => {
    const event = makeEvent(undefined);
    event.body = undefined;
    const res = await handler(event, {} as any, () => {}) as any;

    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.errorCode).toBe('VALIDATION_ERROR');
  });

  it('returns 400 for invalid JSON', async () => {
    const event = makeEvent({ name: 'test' });
    event.body = '{not-valid-json';
    const res = await handler(event, {} as any, () => {}) as any;

    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.errorCode).toBe('VALIDATION_ERROR');
    expect(body.message).toContain('Invalid JSON');
  });

  // ── Edge cases ───────────────────────────────────────────────

  it('rejects a body without a name with 400 and never calls Cognito (BE-078)', async () => {
    const res = await handler(makeEvent({ someOtherField: 'value' }), {} as any, () => {}) as any;

    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).message).toContain('No fields to update');
    expect(cognitoMock.commandCalls(AdminUpdateUserAttributesCommand)).toHaveLength(0);
  });

  it('cannot change the e-mail: the pool would only send a code that nothing confirms (BE-078)', async () => {
    const res = await handler(makeEvent({ email: 'newemail@example.com' }), {} as any, () => {}) as any;

    expect(res.statusCode).toBe(400);
    expect(cognitoMock.commandCalls(AdminUpdateUserAttributesCommand)).toHaveLength(0);
  });

  it.each([[''], ['   '], [123]])('rejects name %j with 400 instead of reporting success (BE-078)', async (name) => {
    const res = await handler(makeEvent({ name }), {} as any, () => {}) as any;

    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).errorCode).toBe('VALIDATION_ERROR');
    expect(cognitoMock.commandCalls(AdminUpdateUserAttributesCommand)).toHaveLength(0);
  });

  // ── Auth edge cases ─────────────────────────────────────────

  it('returns 401 when authorization header has invalid JWT', async () => {
    const event = makeEvent({ name: 'New Name' });
    event.headers = { authorization: 'Bearer not.a.valid.jwt' };
    const res = await handler(event, {} as any, () => {}) as any;

    expect(res.statusCode).toBe(401);
    const body = JSON.parse(res.body);
    expect(body.errorCode).toBe('UNAUTHORIZED');
  });

  // ── Name / email updates individually ───────────────────────

  it('updates only name in Cognito when only name provided', async () => {
    const res = await handler(makeEvent({ name: 'Only Name' }), {} as any, () => {}) as any;

    expect(res.statusCode).toBe(200);
    const cognitoCalls = cognitoMock.commandCalls(AdminUpdateUserAttributesCommand);
    expect(cognitoCalls).toHaveLength(1);
    const attrs = cognitoCalls[0].args[0].input.UserAttributes;
    expect(attrs).toHaveLength(1);
    expect(attrs![0].Name).toBe('name');
    expect(attrs![0].Value).toBe('Only Name');
  });

  // ── Special characters / long values ────────────────────────

  it('handles special characters in name', async () => {
    const specialName = "O'Brien-Smith Jr. III";
    const res = await handler(makeEvent({ name: specialName }), {} as any, () => {}) as any;

    expect(res.statusCode).toBe(200);
    const cognitoCalls = cognitoMock.commandCalls(AdminUpdateUserAttributesCommand);
    expect(cognitoCalls).toHaveLength(1);
    expect(cognitoCalls[0].args[0].input.UserAttributes![0].Value).toBe(specialName);
  });

  it('handles unicode characters in name', async () => {
    const unicodeName = 'Tester';
    const res = await handler(makeEvent({ name: unicodeName }), {} as any, () => {}) as any;

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(true);
  });

  it('handles very long name by passing it to Cognito', async () => {
    const longName = 'A'.repeat(500);
    const res = await handler(makeEvent({ name: longName }), {} as any, () => {}) as any;

    // Handler passes it to Cognito which would reject or accept
    expect(res.statusCode).toBe(200);
    const cognitoCalls = cognitoMock.commandCalls(AdminUpdateUserAttributesCommand);
    expect(cognitoCalls).toHaveLength(1);
    expect(cognitoCalls[0].args[0].input.UserAttributes![0].Value).toBe(longName);
  });

  // ── Empty object body ───────────────────────────────────────

  it('rejects an empty object body with 400', async () => {
    const res = await handler(makeEvent({}), {} as any, () => {}) as any;

    expect(res.statusCode).toBe(400);
    expect(cognitoMock.commandCalls(AdminUpdateUserAttributesCommand)).toHaveLength(0);
  });

  describe('Cognito username (BE-003)', () => {
    it('looks the user up by sub and sends the pool username, not the sub, to the Admin API', async () => {
      const res = await handler(makeEvent({ name: 'Test' }), {} as any, () => {}) as any;

      expect(res.statusCode).toBe(200);
      expect(cognitoMock.commandCalls(ListUsersCommand)[0].args[0].input).toMatchObject({
        UserPoolId: 'us-east-1_TestPool',
        Filter: 'sub = "user-1"',
      });
      const cognitoCalls = cognitoMock.commandCalls(AdminUpdateUserAttributesCommand);
      expect(cognitoCalls).toHaveLength(1);
      expect(cognitoCalls[0].args[0].input.UserPoolId).toBe('us-east-1_TestPool');
      expect(cognitoCalls[0].args[0].input.Username).toBe('Google_999');
    });

    it('uses the cognito:username claim of the signed-in token without a lookup', async () => {
      const event = makeEvent({ name: 'Test' });
      event.headers = { authorization: `Bearer ${makeJwt('user-1', { 'cognito:username': 'Google_123' })}` };
      const res = await handler(event, {} as any, () => {}) as any;

      expect(res.statusCode).toBe(200);
      expect(cognitoMock.commandCalls(ListUsersCommand)).toHaveLength(0);
      expect(cognitoMock.commandCalls(AdminUpdateUserAttributesCommand)[0].args[0].input.Username).toBe('Google_123');
    });

    it('returns 500 when the pool has no such user', async () => {
      cognitoMock.on(ListUsersCommand).resolves({ Users: [] });
      const res = await handler(makeEvent({ name: 'Test' }), {} as any, () => {}) as any;

      expect(res.statusCode).toBe(500);
      expect(cognitoMock.commandCalls(AdminUpdateUserAttributesCommand)).toHaveLength(0);
    });
  });
});
