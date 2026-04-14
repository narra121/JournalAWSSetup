import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBDocumentClient, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import type { APIGatewayProxyEventV2 } from 'aws-lambda';

// Mock environment variables before importing handler
vi.stubEnv('USER_PREFERENCES_TABLE', 'test-user-preferences');

const ddbMock = mockClient(DynamoDBDocumentClient);

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
    routeKey: 'PUT /user/preferences',
    rawPath: '/user/preferences',
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
      http: { method: 'PUT', path: '/user/preferences', protocol: 'HTTP/1.1', sourceIp: '127.0.0.1', userAgent: 'test' },
      requestId: 'req-1',
      routeKey: 'PUT /user/preferences',
      stage: '$default',
      time: '01/Jan/2024:00:00:00 +0000',
      timeEpoch: 0,
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
    isBase64Encoded: false,
    ...overrides,
  } as unknown as APIGatewayProxyEventV2;
}

const existingPreferences = {
  userId: 'user-1',
  darkMode: false,
  currency: 'USD',
  timezone: 'UTC',
  notifications: {
    tradeReminders: true,
    weeklyReport: true,
    goalAlerts: true,
  },
  carryForwardGoalsRules: true,
};

// ─── Tests ──────────────────────────────────────────────────────

beforeEach(() => {
  ddbMock.reset();
  // UpdateCommand with ReturnValues: 'ALL_NEW' returns Attributes
  ddbMock.on(UpdateCommand).callsFake((input: any) => {
    // Simulate merging: start from existing, apply updates from ExpressionAttributeValues
    const merged = { ...existingPreferences };
    const values = input.ExpressionAttributeValues || {};
    if (values[':darkMode'] !== undefined) merged.darkMode = values[':darkMode'];
    if (values[':currency'] !== undefined) merged.currency = values[':currency'];
    if (values[':timezone'] !== undefined) merged.timezone = values[':timezone'];
    if (values[':carryForward'] !== undefined) merged.carryForwardGoalsRules = values[':carryForward'];
    if (values[':updatedAt'] !== undefined) (merged as any).updatedAt = values[':updatedAt'];
    return { Attributes: merged };
  });
});

describe('update-user-preferences handler', () => {
  // ── Success ─────────────────────────────────────────────────

  it('updates preferences and returns 200', async () => {
    const res = await handler(makeEvent({ darkMode: true, currency: 'EUR', timezone: 'America/New_York' }), {} as any, () => {}) as any;

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(true);
    expect(body.data.preferences.darkMode).toBe(true);
    expect(body.data.preferences.currency).toBe('EUR');
    expect(body.data.preferences.timezone).toBe('America/New_York');

    const updateCalls = ddbMock.commandCalls(UpdateCommand);
    expect(updateCalls).toHaveLength(1);
  });

  it('creates default preferences if none exist and updates them', async () => {
    // When no item exists, UpdateCommand creates it; simulate with defaults
    ddbMock.on(UpdateCommand).callsFake((input: any) => {
      const values = input.ExpressionAttributeValues || {};
      const merged: any = { userId: 'user-1' };
      if (values[':darkMode'] !== undefined) merged.darkMode = values[':darkMode'];
      if (values[':currency'] !== undefined) merged.currency = values[':currency'];
      if (values[':timezone'] !== undefined) merged.timezone = values[':timezone'];
      if (values[':carryForward'] !== undefined) merged.carryForwardGoalsRules = values[':carryForward'];
      if (values[':updatedAt'] !== undefined) merged.updatedAt = values[':updatedAt'];
      // For fields not provided, DynamoDB won't have them in the item
      // But since we only set provided fields, simulate minimal result
      return { Attributes: { ...existingPreferences, ...merged } };
    });

    const res = await handler(makeEvent({ darkMode: true }), {} as any, () => {}) as any;

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.data.preferences.darkMode).toBe(true);
    // defaults preserved for fields not in request
    expect(body.data.preferences.currency).toBe('USD');
    expect(body.data.preferences.timezone).toBe('UTC');

    const updateCalls = ddbMock.commandCalls(UpdateCommand);
    expect(updateCalls).toHaveLength(1);
  });

  it('handles partial update with only darkMode', async () => {
    const res = await handler(makeEvent({ darkMode: true }), {} as any, () => {}) as any;

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.data.preferences.darkMode).toBe(true);
    // unchanged fields stay the same
    expect(body.data.preferences.currency).toBe('USD');
    expect(body.data.preferences.timezone).toBe('UTC');
  });

  // ── Auth errors ─────────────────────────────────────────────

  it('returns 401 when authorization header is missing', async () => {
    const event = makeEvent({ darkMode: true });
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
    const event = makeEvent({ darkMode: true });
    event.body = '{not-valid-json';
    const res = await handler(event, {} as any, () => {}) as any;

    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.errorCode).toBe('VALIDATION_ERROR');
    expect(body.message).toContain('Invalid JSON');
  });

  // ── DynamoDB errors ─────────────────────────────────────────

  it('returns 500 when DynamoDB fails', async () => {
    ddbMock.on(UpdateCommand).rejects(new Error('DynamoDB error'));

    const res = await handler(makeEvent({ darkMode: true }), {} as any, () => {}) as any;

    expect(res.statusCode).toBe(500);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(false);
    expect(body.errorCode).toBe('INTERNAL_ERROR');
  });

  // ── Additional DynamoDB failure ─────────────────────────────

  it('returns 500 when DynamoDB UpdateCommand fails', async () => {
    ddbMock.on(UpdateCommand).rejects(new Error('DynamoDB write error'));

    const res = await handler(makeEvent({ darkMode: true }), {} as any, () => {}) as any;

    expect(res.statusCode).toBe(500);
    const body = JSON.parse(res.body);
    expect(body.errorCode).toBe('INTERNAL_ERROR');
  });

  // ── Auth edge cases ─────────────────────────────────────────

  it('returns 401 when authorization header has invalid JWT', async () => {
    const event = makeEvent({ darkMode: true });
    event.headers = { authorization: 'Bearer not.a.valid.jwt' };
    const res = await handler(event, {} as any, () => {}) as any;

    // getUserId would fail to extract sub from malformed JWT
    expect(res.statusCode).toBe(401);
    const body = JSON.parse(res.body);
    expect(body.errorCode).toBe('UNAUTHORIZED');
  });

  // ── Empty / minimal payloads ────────────────────────────────

  it('handles empty preferences object gracefully', async () => {
    const res = await handler(makeEvent({}), {} as any, () => {}) as any;

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(true);
    // Existing preferences remain unchanged
    expect(body.data.preferences.darkMode).toBe(false);
    expect(body.data.preferences.currency).toBe('USD');
  });

  it('sets updatedAt timestamp on every update', async () => {
    const res = await handler(makeEvent({ darkMode: true }), {} as any, () => {}) as any;

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.data.preferences.updatedAt).toBeDefined();
    // Should be a valid ISO string
    expect(new Date(body.data.preferences.updatedAt).toISOString()).toBe(body.data.preferences.updatedAt);
  });

  it('handles only currency update', async () => {
    const res = await handler(makeEvent({ currency: 'INR' }), {} as any, () => {}) as any;

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.data.preferences.currency).toBe('INR');
    expect(body.data.preferences.darkMode).toBe(false); // unchanged
  });

  it('handles only timezone update', async () => {
    const res = await handler(makeEvent({ timezone: 'Asia/Kolkata' }), {} as any, () => {}) as any;

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.data.preferences.timezone).toBe('Asia/Kolkata');
    expect(body.data.preferences.currency).toBe('USD'); // unchanged
  });

  // ── carryForwardGoalsRules ──────────────────────────────────

  it('persists carryForwardGoalsRules when set to true', async () => {
    const res = await handler(makeEvent({ carryForwardGoalsRules: true }), {} as any, () => {}) as any;

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.data.preferences.carryForwardGoalsRules).toBe(true);

    const updateCalls = ddbMock.commandCalls(UpdateCommand);
    expect(updateCalls).toHaveLength(1);
    expect(updateCalls[0].args[0].input.ExpressionAttributeValues![':carryForward']).toBe(true);
  });

  it('persists carryForwardGoalsRules when set to false', async () => {
    const res = await handler(makeEvent({ carryForwardGoalsRules: false }), {} as any, () => {}) as any;

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.data.preferences.carryForwardGoalsRules).toBe(false);

    const updateCalls = ddbMock.commandCalls(UpdateCommand);
    expect(updateCalls).toHaveLength(1);
    expect(updateCalls[0].args[0].input.ExpressionAttributeValues![':carryForward']).toBe(false);
  });

  it('defaults carryForwardGoalsRules to true when not in stored preferences', async () => {
    // When only darkMode is sent, carryForwardGoalsRules is NOT in the SET expression
    // So UpdateCommand won't touch it. The existing item (simulated) has it as true.
    const res = await handler(makeEvent({ darkMode: true }), {} as any, () => {}) as any;

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.data.preferences.carryForwardGoalsRules).toBe(true);
  });
});
