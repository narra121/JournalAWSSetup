import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBDocumentClient, GetCommand } from '@aws-sdk/lib-dynamodb';
import type { APIGatewayProxyEventV2 } from 'aws-lambda';

// Mock environment variables before importing handler
vi.stubEnv('USER_PREFERENCES_TABLE', 'test-user-preferences');

const ddbMock = mockClient(DynamoDBDocumentClient);

const { handler } = await import('../app.ts');

// ─── Helpers ────────────────────────────────────────────────────

function makeJwt(claims: Record<string, string>): string {
  const header = btoa(JSON.stringify({ alg: 'RS256' }));
  const payload = btoa(JSON.stringify(claims));
  return `${header}.${payload}.sig`;
}

function makeEvent(jwtClaims: Record<string, string> = { sub: 'user-1', name: 'Test User', email: 'test@example.com' }, overrides: Partial<APIGatewayProxyEventV2> = {}): APIGatewayProxyEventV2 {
  return {
    version: '2.0',
    routeKey: 'GET /user/profile',
    rawPath: '/user/profile',
    rawQueryString: '',
    headers: {
      authorization: `Bearer ${makeJwt(jwtClaims)}`,
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

  it('returns empty name and email when JWT has no name/email claims', async () => {
    const res = await handler(makeEvent({ sub: 'user-1' }), {} as any, () => {}) as any;

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

  it('returns 500 with correct error message when DynamoDB fails', async () => {
    ddbMock.on(GetCommand).rejects(new Error('DynamoDB timeout'));

    const res = await handler(makeEvent(), {} as any, () => {}) as any;

    expect(res.statusCode).toBe(500);
    const body = JSON.parse(res.body);
    expect(body.message).toBe('Failed to retrieve user profile');
  });

  // ── Auth edge cases ────────────────────────────────────────

  it('returns 401 when token is malformed (no sub claim)', async () => {
    const badHeader = btoa(JSON.stringify({ alg: 'RS256' }));
    const badPayload = btoa(JSON.stringify({ iss: 'bad' }));
    const event = makeEvent({ headers: { authorization: `Bearer ${badHeader}.${badPayload}.sig` } });
    const res = await handler(event, {} as any, () => {}) as any;

    expect(res.statusCode).toBe(401);
    const body = JSON.parse(res.body);
    expect(body.errorCode).toBe('UNAUTHORIZED');
  });

  // ── Profile with all fields populated ──────────────────────

  it('returns profile with all custom preferences populated', async () => {
    const fullPrefs = {
      userId: 'user-1',
      darkMode: true,
      currency: 'INR',
      timezone: 'Asia/Kolkata',
      language: 'hi',
      dateFormat: 'DD/MM/YYYY',
      notifications: {
        tradeReminders: true,
        weeklyReport: false,
        goalAlerts: true,
        emailDigest: true,
      },
    };
    ddbMock.on(GetCommand).resolves({ Item: fullPrefs });

    const res = await handler(makeEvent(), {} as any, () => {}) as any;

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.data.user.preferences.currency).toBe('INR');
    expect(body.data.user.preferences.timezone).toBe('Asia/Kolkata');
    expect(body.data.user.preferences.language).toBe('hi');
    expect(body.data.user.preferences.dateFormat).toBe('DD/MM/YYYY');
    expect(body.data.user.preferences.notifications.emailDigest).toBe(true);
  });

  // ── Cognito user info ──────────────────────────────────────

  it('returns empty name and email when JWT claims lack those fields', async () => {
    const res = await handler(makeEvent({ sub: 'user-1', phone_number: '+1234567890' }), {} as any, () => {}) as any;

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.data.user.name).toBe('');
    expect(body.data.user.email).toBe('');
  });

  it('returns empty name and email when authorization header has no token (empty Bearer)', async () => {
    const event = makeEvent({ headers: { authorization: 'Bearer ' } });
    // getUserId will return undefined for empty bearer => 401
    const res = await handler(event, {} as any, () => {}) as any;

    expect(res.statusCode).toBe(401);
    const body = JSON.parse(res.body);
    expect(body.errorCode).toBe('UNAUTHORIZED');
  });

  // ── Response shape ─────────────────────────────────────────

  it('response contains message "User profile retrieved" on success', async () => {
    const res = await handler(makeEvent(), {} as any, () => {}) as any;

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.message).toBe('User profile retrieved');
  });

  it('user object always includes id field matching userId', async () => {
    const res = await handler(makeEvent(), {} as any, () => {}) as any;

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.data.user.id).toBe('user-1');
  });

  // ── Cognito with different user ────────────────────────────

  it('returns user data from JWT claims for a different user', async () => {
    const res = await handler(makeEvent({ sub: 'user-2', name: 'Jane Doe', email: 'jane@example.com' }), {} as any, () => {}) as any;

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.data.user.name).toBe('Jane Doe');
    expect(body.data.user.email).toBe('jane@example.com');
    expect(body.data.user.id).toBe('user-2');
  });
});
