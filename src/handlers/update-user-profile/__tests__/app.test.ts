import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { CognitoIdentityProviderClient, AdminUpdateUserAttributesCommand } from '@aws-sdk/client-cognito-identity-provider';
import type { APIGatewayProxyEventV2 } from 'aws-lambda';

vi.stubEnv('USER_POOL_ID', 'us-east-1_TestPool');

const cognitoMock = mockClient(CognitoIdentityProviderClient);

const { handler } = await import('../app.ts');

// ─── Helpers ────────────────────────────────────────────────────

function makeJwt(sub: string): string {
  const header = btoa(JSON.stringify({ alg: 'RS256' }));
  const payload = btoa(JSON.stringify({ sub }));
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
});

describe('update-user-profile handler', () => {
  // ── Success ─────────────────────────────────────────────────

  it('updates profile and returns 200', async () => {
    const res = await handler(makeEvent({ name: 'New Name', email: 'new@example.com' }), {} as any, () => {}) as any;

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(true);
    expect(body.message).toContain('updated');

    const cognitoCalls = cognitoMock.commandCalls(AdminUpdateUserAttributesCommand);
    expect(cognitoCalls).toHaveLength(1);
    const attrs = cognitoCalls[0].args[0].input.UserAttributes;
    expect(attrs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ Name: 'name', Value: 'New Name' }),
        expect.objectContaining({ Name: 'email', Value: 'new@example.com' }),
      ]),
    );
  });

  it('handles Cognito update failure gracefully', async () => {
    cognitoMock.on(AdminUpdateUserAttributesCommand).rejects(new Error('Cognito update failed'));

    const res = await handler(makeEvent({ name: 'New Name' }), {} as any, () => {}) as any;

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(true);
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

  it('skips Cognito update when no name or email provided', async () => {
    const res = await handler(makeEvent({ someOtherField: 'value' }), {} as any, () => {}) as any;

    expect(res.statusCode).toBe(200);
    const cognitoCalls = cognitoMock.commandCalls(AdminUpdateUserAttributesCommand);
    expect(cognitoCalls).toHaveLength(0);
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

  it('updates only email in Cognito when only email provided', async () => {
    const res = await handler(makeEvent({ email: 'newemail@example.com' }), {} as any, () => {}) as any;

    expect(res.statusCode).toBe(200);
    const cognitoCalls = cognitoMock.commandCalls(AdminUpdateUserAttributesCommand);
    expect(cognitoCalls).toHaveLength(1);
    const attrs = cognitoCalls[0].args[0].input.UserAttributes;
    expect(attrs).toHaveLength(1);
    expect(attrs![0].Name).toBe('email');
    expect(attrs![0].Value).toBe('newemail@example.com');
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

  it('handles empty object body gracefully', async () => {
    const res = await handler(makeEvent({}), {} as any, () => {}) as any;

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(true);
    // No Cognito calls since no name or email
    const cognitoCalls = cognitoMock.commandCalls(AdminUpdateUserAttributesCommand);
    expect(cognitoCalls).toHaveLength(0);
  });

  it('sends UserPoolId and Username (userId) to Cognito Admin API', async () => {
    const res = await handler(makeEvent({ name: 'Test' }), {} as any, () => {}) as any;

    expect(res.statusCode).toBe(200);
    const cognitoCalls = cognitoMock.commandCalls(AdminUpdateUserAttributesCommand);
    expect(cognitoCalls).toHaveLength(1);
    expect(cognitoCalls[0].args[0].input.UserPoolId).toBe('us-east-1_TestPool');
    expect(cognitoCalls[0].args[0].input.Username).toBe('user-1');
  });
});
