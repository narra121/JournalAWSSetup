import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import {
  CognitoIdentityProviderClient,
  AdminUpdateUserAttributesCommand,
} from '@aws-sdk/client-cognito-identity-provider';
import type { APIGatewayProxyEventV2 } from 'aws-lambda';

// ─── Env (must be before any module-scope reads) ──────────────
vi.stubEnv('USER_POOL_ID', 'us-east-1_TestPool');

// ─── SDK mocks ────────────────────────────────────────────────
const cognitoMock = mockClient(CognitoIdentityProviderClient);

// Dynamic import to ensure env vars are set before module-scope reads
const { handler } = await import('../app');

// ─── Helpers ──────────────────────────────────────────────────
const TEST_USER_ID = 'user-abc-123';

function makeEvent(
  pathUserId?: string,
  body?: any,
): APIGatewayProxyEventV2 {
  return {
    version: '2.0',
    routeKey: 'PUT /v1/admin/users/{userId}',
    rawPath: `/v1/admin/users/${pathUserId || ''}`,
    rawQueryString: '',
    headers: {},
    pathParameters: pathUserId ? { userId: pathUserId } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
    requestContext: {
      accountId: '123',
      apiId: 'api',
      domainName: 'api.example.com',
      domainPrefix: 'api',
      http: {
        method: 'PUT',
        path: `/v1/admin/users/${pathUserId || ''}`,
        protocol: 'HTTP/1.1',
        sourceIp: '127.0.0.1',
        userAgent: 'test',
      },
      requestId: 'req-1',
      routeKey: 'PUT /v1/admin/users/{userId}',
      stage: '$default',
      time: '01/Jan/2024:00:00:00 +0000',
      timeEpoch: 0,
    },
    isBase64Encoded: false,
  } as unknown as APIGatewayProxyEventV2;
}

// ─── Setup ────────────────────────────────────────────────────
beforeEach(() => {
  cognitoMock.reset();
  cognitoMock.on(AdminUpdateUserAttributesCommand).resolves({});
});

// ─── Tests ────────────────────────────────────────────────────
describe('admin-update-user handler', () => {
  // ── Validation errors ───────────────────────────────────────

  it('returns 400 if userId path parameter is missing', async () => {
    const event = makeEvent(undefined, { name: 'Test' });
    (event as any).pathParameters = undefined;

    const res = (await handler(event, {} as any, () => {})) as any;

    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(false);
    expect(body.errorCode).toBe('VALIDATION_ERROR');
    expect(body.message).toContain('userId');
  });

  it('returns 400 if body is missing', async () => {
    const event = makeEvent(TEST_USER_ID, undefined);
    event.body = undefined;

    const res = (await handler(event, {} as any, () => {})) as any;

    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(false);
    expect(body.errorCode).toBe('VALIDATION_ERROR');
    expect(body.message).toContain('Missing body');
  });

  it('returns 400 for invalid JSON body', async () => {
    const event = makeEvent(TEST_USER_ID, { name: 'test' });
    event.body = '{not-valid-json';

    const res = (await handler(event, {} as any, () => {})) as any;

    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(false);
    expect(body.errorCode).toBe('VALIDATION_ERROR');
    expect(body.message).toContain('Invalid JSON');
  });

  it('returns 400 if no updatable fields provided (empty object)', async () => {
    const res = (await handler(makeEvent(TEST_USER_ID, {}), {} as any, () => {})) as any;

    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(false);
    expect(body.errorCode).toBe('VALIDATION_ERROR');
    expect(body.message).toContain('No fields to update');
  });

  it('returns 400 if name is not a string', async () => {
    const res = (await handler(makeEvent(TEST_USER_ID, { name: 123 }), {} as any, () => {})) as any;

    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(false);
    expect(body.errorCode).toBe('VALIDATION_ERROR');
    expect(body.message).toContain('name must be a string');
  });

  // ── Success ─────────────────────────────────────────────────

  it('returns 200 and updates name in Cognito on success', async () => {
    const res = (await handler(makeEvent(TEST_USER_ID, { name: 'New Name' }), {} as any, () => {})) as any;

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(true);
    expect(body.message).toContain('updated');
    expect(body.data.userId).toBe(TEST_USER_ID);
    expect(body.data.updated).toContain('name');
  });

  it('sends correct AdminUpdateUserAttributesCommand to Cognito', async () => {
    await handler(makeEvent(TEST_USER_ID, { name: 'Updated' }), {} as any, () => {});

    const calls = cognitoMock.commandCalls(AdminUpdateUserAttributesCommand);
    expect(calls).toHaveLength(1);
    expect(calls[0].args[0].input).toEqual({
      UserPoolId: 'us-east-1_TestPool',
      Username: TEST_USER_ID,
      UserAttributes: [{ Name: 'name', Value: 'Updated' }],
    });
  });

  it('does not call Cognito when only unknown fields are provided', async () => {
    const res = (await handler(makeEvent(TEST_USER_ID, { unknownField: 'value' }), {} as any, () => {})) as any;

    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.message).toContain('No fields to update');

    const calls = cognitoMock.commandCalls(AdminUpdateUserAttributesCommand);
    expect(calls).toHaveLength(0);
  });

  // ── Error handling ──────────────────────────────────────────

  it('returns 500 when Cognito call fails', async () => {
    cognitoMock.on(AdminUpdateUserAttributesCommand).rejects(new Error('Cognito unavailable'));

    const res = (await handler(makeEvent(TEST_USER_ID, { name: 'Test' }), {} as any, () => {})) as any;

    expect(res.statusCode).toBe(500);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(false);
    expect(body.errorCode).toBe('INTERNAL_ERROR');
  });

  // ── Edge cases ──────────────────────────────────────────────

  it('handles special characters in name', async () => {
    const specialName = "O'Brien-Smith Jr. III";
    const res = (await handler(makeEvent(TEST_USER_ID, { name: specialName }), {} as any, () => {})) as any;

    expect(res.statusCode).toBe(200);
    const calls = cognitoMock.commandCalls(AdminUpdateUserAttributesCommand);
    expect(calls[0].args[0].input.UserAttributes![0].Value).toBe(specialName);
  });

  it('handles empty string name', async () => {
    const res = (await handler(makeEvent(TEST_USER_ID, { name: '' }), {} as any, () => {})) as any;

    expect(res.statusCode).toBe(200);
    const calls = cognitoMock.commandCalls(AdminUpdateUserAttributesCommand);
    expect(calls[0].args[0].input.UserAttributes![0].Value).toBe('');
  });
});
