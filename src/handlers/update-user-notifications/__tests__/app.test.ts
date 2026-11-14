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
    routeKey: 'PUT /user/notifications',
    rawPath: '/user/notifications',
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
      http: { method: 'PUT', path: '/user/notifications', protocol: 'HTTP/1.1', sourceIp: '127.0.0.1', userAgent: 'test' },
      requestId: 'req-1',
      routeKey: 'PUT /user/notifications',
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
  timeZone: 'UTC',
  notifications: {
    tradeReminders: true,
    weeklyReport: true,
    goalAlerts: true,
  },
};

// ─── Tests ──────────────────────────────────────────────────────

beforeEach(() => {
  ddbMock.reset();
  // UpdateCommand with ReturnValues: 'ALL_NEW' returns Attributes
  ddbMock.on(UpdateCommand).callsFake((input: any) => {
    const notifications = { ...existingPreferences.notifications };
    const values = input.ExpressionAttributeValues || {};
    if (values[':tradeReminders'] !== undefined) notifications.tradeReminders = values[':tradeReminders'];
    if (values[':weeklyReport'] !== undefined) notifications.weeklyReport = values[':weeklyReport'];
    if (values[':goalAlerts'] !== undefined) notifications.goalAlerts = values[':goalAlerts'];
    return {
      Attributes: {
        ...existingPreferences,
        notifications,
        updatedAt: values[':updatedAt'],
      }
    };
  });
});

describe('update-user-notifications handler', () => {
  // ── Success ─────────────────────────────────────────────────

  it('updates notifications and returns 200', async () => {
    const res = await handler(makeEvent({ tradeReminders: false, weeklyReport: false, goalAlerts: false }), {} as any, () => {}) as any;

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(true);
    expect(body.data.notifications.tradeReminders).toBe(false);
    expect(body.data.notifications.weeklyReport).toBe(false);
    expect(body.data.notifications.goalAlerts).toBe(false);

    // One write when the `notifications` map exists (L3).
    const updateCalls = ddbMock.commandCalls(UpdateCommand);
    expect(updateCalls).toHaveLength(1);
    const input = updateCalls[0].args[0].input;
    expect(input.UpdateExpression).toBe('SET #notifications.#tradeReminders = :tradeReminders, #notifications.#weeklyReport = :weeklyReport, #notifications.#goalAlerts = :goalAlerts, #updatedAt = :updatedAt');
    expect(input.ConditionExpression).toBe('attribute_exists(#notifications)');
    expect(input.ExpressionAttributeValues).toMatchObject({ ':tradeReminders': false, ':weeklyReport': false, ':goalAlerts': false });
  });

  it('a partial update names only the flags it carries', async () => {
    await handler(makeEvent({ weeklyReport: false }), {} as any, () => {});
    const input = ddbMock.commandCalls(UpdateCommand)[0].args[0].input;
    expect(input.UpdateExpression).toBe('SET #notifications.#weeklyReport = :weeklyReport, #updatedAt = :updatedAt');
    expect(Object.keys(input.ExpressionAttributeNames!).sort()).toEqual(['#notifications', '#updatedAt', '#weeklyReport']);
  });

  it.each([{}, { unknown: true }, { tradeReminders: undefined }])('rejects the body %j: it carries no flag, so nothing is written (L3)', async (body) => {
    const res = await handler(makeEvent(body), {} as any, () => {}) as any;
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).errorCode).toBe('VALIDATION_ERROR');
    expect(ddbMock.commandCalls(UpdateCommand)).toHaveLength(0);
  });

  it('a user without a notifications map (or preferences item) gets it created once, then the flags are set', async () => {
    const missing = Object.assign(new Error('no map'), { name: 'ConditionalCheckFailedException' });
    ddbMock.on(UpdateCommand)
      .rejectsOnce(missing)
      .resolvesOnce({})
      .resolves({ Attributes: { userId: 'user-1', notifications: { tradeReminders: false } } });

    const res = await handler(makeEvent({ tradeReminders: false }), {} as any, () => {}) as any;

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).data.notifications).toEqual({ tradeReminders: false });
    const calls = ddbMock.commandCalls(UpdateCommand).map((c) => c.args[0].input);
    expect(calls).toHaveLength(3);
    expect(calls[1].UpdateExpression).toBe('SET #notifications = if_not_exists(#notifications, :empty)');
    expect(calls[2].UpdateExpression).toContain('#notifications.#tradeReminders');
  });

  it.each([
    ['weeklyReport', 'false'],
    ['weeklyReport', 0],
    ['tradeReminders', 'no'],
    ['goalAlerts', null],
  ])('rejects %s = %j with 400, so a string never leaves the weekly mail on (BE-077)', async (field, value) => {
    const res = await handler(makeEvent({ [field]: value }), {} as any, () => {}) as any;

    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).message).toContain(`${field} must be true or false`);
    expect(ddbMock.commandCalls(UpdateCommand)).toHaveLength(0);
  });

  it('handles partial update with only tradeReminders', async () => {
    const res = await handler(makeEvent({ tradeReminders: false }), {} as any, () => {}) as any;

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.data.notifications.tradeReminders).toBe(false);
    // unchanged fields stay the same
    expect(body.data.notifications.weeklyReport).toBe(true);
    expect(body.data.notifications.goalAlerts).toBe(true);
  });

  it('initializes empty notifications if missing from preferences', async () => {
    ddbMock.on(UpdateCommand).callsFake((input: any) => {
      const notifications: any = {};
      const values = input.ExpressionAttributeValues || {};
      if (values[':tradeReminders'] !== undefined) notifications.tradeReminders = values[':tradeReminders'];
      if (values[':weeklyReport'] !== undefined) notifications.weeklyReport = values[':weeklyReport'];
      if (values[':goalAlerts'] !== undefined) notifications.goalAlerts = values[':goalAlerts'];
      return {
        Attributes: {
          userId: 'user-1',
          darkMode: false,
          currency: 'USD',
          timezone: 'UTC',
          notifications,
          updatedAt: values[':updatedAt'],
        }
      };
    });

    const res = await handler(makeEvent({ tradeReminders: true }), {} as any, () => {}) as any;

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.data.notifications).toBeDefined();
    expect(body.data.notifications.tradeReminders).toBe(true);
  });

  // ── Auth errors ─────────────────────────────────────────────

  it('returns 401 when authorization header is missing', async () => {
    const event = makeEvent({ tradeReminders: false });
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
    const event = makeEvent({ tradeReminders: false });
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

    const res = await handler(makeEvent({ tradeReminders: false }), {} as any, () => {}) as any;

    expect(res.statusCode).toBe(500);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(false);
    expect(body.errorCode).toBe('INTERNAL_ERROR');
  });
});
