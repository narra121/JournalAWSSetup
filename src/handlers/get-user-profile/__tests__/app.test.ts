import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBDocumentClient, GetCommand } from '@aws-sdk/lib-dynamodb';
import { CognitoIdentityProviderClient, GetUserCommand } from '@aws-sdk/client-cognito-identity-provider';
import type { APIGatewayProxyEventV2 } from 'aws-lambda';

// Mock environment variables before importing handler
vi.stubEnv('USER_PREFERENCES_TABLE', 'test-user-preferences');

const ddbMock = mockClient(DynamoDBDocumentClient);
const cognitoMock = mockClient(CognitoIdentityProviderClient);

const { handler } = await import('../app.ts');

// ─── Helpers ────────────────────────────────────────────────────

function makeJwt(sub: string): string {
  const header = btoa(JSON.stringify({ alg: 'RS256' }));
  const payload = btoa(JSON.stringify({ sub }));
  return `${header}.${payload}.sig`;
}

function makeEvent(overrides: Partial<APIGatewayProxyEventV2> = {}): APIGatewayProxyEventV2 {
  return {
    version: '2.0',
    routeKey: 'GET /user/profile',
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
      http: { method: 'GET', path: '/user/profile', protocol: 'HTTP/1.1', sourceIp: '127.0.0.1', userAgent: 'test' },
      requestId: 'req-1',
      routeKey: 'GET /user/profile',
      stage: '$default',
      time: '01/Jan/2024:00:00:00 +0000',
      timeEpoch: 0,
    },
    isBase64Encoded: false,
    ...overrides,
  } as unknown as APIGatewayProxyEventV2;
}

const storedPreferences = {
  userId: 'user-1',
  darkMode: true,
  currency: 'EUR',
  timezone: 'America/New_York',
  notifications: {
    tradeReminders: false,
    weeklyReport: true,
    goalAlerts: false,
  },
};

// ─── Tests ──────────────────────────────────────────────────────

beforeEach(() => {
  ddbMock.reset();
  cognitoMock.reset();
  cognitoMock.on(GetUserCommand).resolves({
    UserAttributes: [
      { Name: 'name', Value: 'Test User' },
      { Name: 'email', Value: 'test@example.com' },
    ],
    Username: 'user-1',
  });
  ddbMock.on(GetCommand).resolves({ Item: { ...storedPreferences } });
});

describe('get-user-profile handler', () => {
  // ── Success ─────────────────────────────────────────────────

  it('returns user profile with Cognito data and stored preferences', async () => {
    const res = await handler(makeEvent(), {} as any, () => {}) as any;

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(true);
    expect(body.data.user).toBeDefined();
    expect(body.data.user.id).toBe('user-1');
    expect(body.data.user.name).toBe('Test User');
    expect(body.data.user.email).toBe('test@example.com');
    expect(body.data.user.preferences.darkMode).toBe(true);
    expect(body.data.user.preferences.currency).toBe('EUR');
    expect(body.data.user.preferences.timezone).toBe('America/New_York');
  });

  it('returns default preferences when none stored', async () => {
    ddbMock.on(GetCommand).resolves({ Item: undefined });

    const res = await handler(makeEvent(), {} as any, () => {}) as any;

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.data.user.preferences).toBeDefined();
    expect(body.data.user.preferences.darkMode).toBe(false);
    expect(body.data.user.preferences.currency).toBe('USD');
    expect(body.data.user.preferences.timezone).toBe('UTC');
    expect(body.data.user.preferences.notifications.tradeReminders).toBe(true);
    expect(body.data.user.preferences.notifications.weeklyReport).toBe(true);
    expect(body.data.user.preferences.notifications.goalAlerts).toBe(true);
  });

  it('handles Cognito failure gracefully and still returns profile', async () => {
    cognitoMock.on(GetUserCommand).rejects(new Error('Cognito unavailable'));

    const res = await handler(makeEvent(), {} as any, () => {}) as any;

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(true);
    expect(body.data.user.id).toBe('user-1');
    expect(body.data.user.name).toBe('');
    expect(body.data.user.email).toBe('');
    expect(body.data.user.preferences).toBeDefined();
  });

  // ── Auth errors ─────────────────────────────────────────────

  it('returns 401 when authorization header is missing', async () => {
    const event = makeEvent();
    event.headers = {};
    const res = await handler(event, {} as any, () => {}) as any;

    expect(res.statusCode).toBe(401);
    const body = JSON.parse(res.body);
    expect(body.errorCode).toBe('UNAUTHORIZED');
  });

  // ── DynamoDB errors ─────────────────────────────────────────

  it('returns 500 when DynamoDB GetCommand fails', async () => {
    ddbMock.on(GetCommand).rejects(new Error('DynamoDB error'));

    const res = await handler(makeEvent(), {} as any, () => {}) as any;

    expect(res.statusCode).toBe(500);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(false);
    expect(body.errorCode).toBe('INTERNAL_ERROR');
  });
});
