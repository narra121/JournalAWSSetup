import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBDocumentClient, GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import type { APIGatewayProxyEventV2 } from 'aws-lambda';

vi.stubEnv('RULES_TABLE', 'test-rules');

const ddbMock = mockClient(DynamoDBDocumentClient);

vi.mock('../../../shared/subscription', () => ({
  checkSubscription: vi.fn().mockResolvedValue(null),
}));

const { handler } = await import('../app.ts');

// ─── Helpers ────────────────────────────────────────────────────

function makeJwt(sub: string): string {
  const header = btoa(JSON.stringify({ alg: 'RS256' }));
  const payload = btoa(JSON.stringify({ sub }));
  return `${header}.${payload}.sig`;
}

function makeEvent(ruleId?: string, overrides: Partial<APIGatewayProxyEventV2> = {}): APIGatewayProxyEventV2 {
  return {
    version: '2.0',
    routeKey: 'PATCH /rules/{ruleId}/toggle',
    rawPath: `/rules/${ruleId || ''}/toggle`,
    rawQueryString: '',
    headers: {
      authorization: `Bearer ${makeJwt('user-1')}`,
    },
    pathParameters: ruleId ? { ruleId } : {},
    requestContext: {
      accountId: '123',
      apiId: 'api',
      domainName: 'api.example.com',
      domainPrefix: 'api',
      http: { method: 'PATCH', path: `/rules/${ruleId || ''}/toggle`, protocol: 'HTTP/1.1', sourceIp: '127.0.0.1', userAgent: 'test' },
      requestId: 'req-1',
      routeKey: 'PATCH /rules/{ruleId}/toggle',
      stage: '$default',
      time: '01/Jan/2024:00:00:00 +0000',
      timeEpoch: 0,
    },
    isBase64Encoded: false,
    ...overrides,
  } as unknown as APIGatewayProxyEventV2;
}

const existingRule = {
  userId: 'user-1',
  ruleId: 'rule-1',
  rule: 'Never risk more than 1%',
  completed: false,
  isActive: true,
  createdAt: '2024-01-01T00:00:00.000Z',
  updatedAt: '2024-01-01T00:00:00.000Z',
};

// ─── Tests ──────────────────────────────────────────────────────

beforeEach(() => {
  ddbMock.reset();
});

describe('toggle-rule handler', () => {
  it('returns 403 when subscription is inactive', async () => {
    const { checkSubscription } = await import('../../../shared/subscription');
    vi.mocked(checkSubscription).mockResolvedValueOnce({
      statusCode: 403,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ success: false, error: { code: 'SUBSCRIPTION_REQUIRED', message: 'Please subscribe', details: { reason: 'trial_expired' } } }),
    } as any);

    const res = await handler(makeEvent('rule-1'), {} as any, () => {}) as any;

    expect(res.statusCode).toBe(403);
    const body = JSON.parse(res.body);
    expect(body.error.code).toBe('SUBSCRIPTION_REQUIRED');
  });

  // ── Success ─────────────────────────────────────────────────

  it('toggles completed from false to true', async () => {
    ddbMock.on(GetCommand).resolves({ Item: { ...existingRule, completed: false } });
    ddbMock.on(UpdateCommand).resolves({ Attributes: { ...existingRule, completed: true } });

    const res = await handler(makeEvent('rule-1'), {} as any, () => {}) as any;

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(true);
    expect(body.data.rule).toBeDefined();
    expect(body.data.rule.completed).toBe(true);
  });

  it('toggles completed from true to false', async () => {
    ddbMock.on(GetCommand).resolves({ Item: { ...existingRule, completed: true } });
    ddbMock.on(UpdateCommand).resolves({ Attributes: { ...existingRule, completed: false } });

    const res = await handler(makeEvent('rule-1'), {} as any, () => {}) as any;

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(true);
    expect(body.data.rule.completed).toBe(false);
  });

  // ── Auth errors ─────────────────────────────────────────────

  it('returns 401 when authorization header is missing', async () => {
    const event = makeEvent('rule-1', { headers: {} });
    const res = await handler(event, {} as any, () => {}) as any;

    expect(res.statusCode).toBe(401);
    const body = JSON.parse(res.body);
    expect(body.errorCode).toBe('UNAUTHORIZED');
  });

  // ── Validation errors ───────────────────────────────────────

  it('returns 400 when ruleId is missing', async () => {
    const event = makeEvent(undefined);
    event.pathParameters = {};
    const res = await handler(event, {} as any, () => {}) as any;

    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.errorCode).toBe('VALIDATION_ERROR');
  });

  // ── Not found ───────────────────────────────────────────────

  it('returns 404 when rule does not exist', async () => {
    ddbMock.on(GetCommand).resolves({ Item: undefined });

    const res = await handler(makeEvent('nonexistent'), {} as any, () => {}) as any;

    expect(res.statusCode).toBe(404);
    const body = JSON.parse(res.body);
    expect(body.errorCode).toBe('NOT_FOUND');
  });

  // ── DynamoDB errors ─────────────────────────────────────────

  it('returns 500 when DynamoDB fails', async () => {
    ddbMock.on(GetCommand).rejects(new Error('DynamoDB error'));

    const res = await handler(makeEvent('rule-1'), {} as any, () => {}) as any;

    expect(res.statusCode).toBe(500);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(false);
    expect(body.errorCode).toBe('INTERNAL_ERROR');
  });

  // ── Additional coverage ─────────────────────────────────────

  it('returns 500 when DynamoDB UpdateCommand fails after successful Get', async () => {
    ddbMock.on(GetCommand).resolves({ Item: { ...existingRule, completed: false } });
    ddbMock.on(UpdateCommand).rejects(new Error('Update failed'));

    const res = await handler(makeEvent('rule-1'), {} as any, () => {}) as any;

    expect(res.statusCode).toBe(500);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(false);
    expect(body.errorCode).toBe('INTERNAL_ERROR');
  });

  it('returns 401 when authorization token is malformed', async () => {
    const event = makeEvent('rule-1', { headers: { authorization: 'Bearer not-a-jwt' } });
    const res = await handler(event, {} as any, () => {}) as any;

    expect(res.statusCode).toBe(401);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(false);
    expect(body.errorCode).toBe('UNAUTHORIZED');
  });

  it('returns 400 when pathParameters is undefined', async () => {
    const event = makeEvent(undefined);
    event.pathParameters = undefined as any;
    const res = await handler(event, {} as any, () => {}) as any;

    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.errorCode).toBe('VALIDATION_ERROR');
  });

  it('sends correct UpdateCommand with toggled completed value', async () => {
    ddbMock.on(GetCommand).resolves({ Item: { ...existingRule, completed: false } });
    ddbMock.on(UpdateCommand).resolves({ Attributes: { ...existingRule, completed: true } });

    await handler(makeEvent('rule-1'), {} as any, () => {});

    const updateCalls = ddbMock.commandCalls(UpdateCommand);
    expect(updateCalls).toHaveLength(1);
    expect(updateCalls[0].args[0].input.ExpressionAttributeValues![':completed']).toBe(true);
  });

  it('sends correct Key to GetCommand and UpdateCommand', async () => {
    ddbMock.on(GetCommand).resolves({ Item: { ...existingRule, completed: true } });
    ddbMock.on(UpdateCommand).resolves({ Attributes: { ...existingRule, completed: false } });

    await handler(makeEvent('rule-1'), {} as any, () => {});

    const getCalls = ddbMock.commandCalls(GetCommand);
    expect(getCalls).toHaveLength(1);
    expect(getCalls[0].args[0].input.Key).toEqual({ userId: 'user-1', ruleId: 'rule-1' });

    const updateCalls = ddbMock.commandCalls(UpdateCommand);
    expect(updateCalls).toHaveLength(1);
    expect(updateCalls[0].args[0].input.Key).toEqual({ userId: 'user-1', ruleId: 'rule-1' });
  });

  it('does not call UpdateCommand when rule is not found', async () => {
    ddbMock.on(GetCommand).resolves({ Item: undefined });

    await handler(makeEvent('nonexistent'), {} as any, () => {});

    const updateCalls = ddbMock.commandCalls(UpdateCommand);
    expect(updateCalls).toHaveLength(0);
  });

  it('returns 500 when DynamoDB throws ProvisionedThroughputExceededException', async () => {
    const awsError = new Error('Throughput exceeded');
    awsError.name = 'ProvisionedThroughputExceededException';
    ddbMock.on(GetCommand).rejects(awsError);

    const res = await handler(makeEvent('rule-1'), {} as any, () => {}) as any;

    expect(res.statusCode).toBe(500);
    const body = JSON.parse(res.body);
    expect(body.errorCode).toBe('INTERNAL_ERROR');
  });

  it('returns the updated rule attributes in the response', async () => {
    const updatedRule = { ...existingRule, completed: true, updatedAt: '2024-06-16T00:00:00Z' };
    ddbMock.on(GetCommand).resolves({ Item: { ...existingRule, completed: false } });
    ddbMock.on(UpdateCommand).resolves({ Attributes: updatedRule });

    const res = await handler(makeEvent('rule-1'), {} as any, () => {}) as any;

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.data.rule.ruleId).toBe('rule-1');
    expect(body.data.rule.completed).toBe(true);
    expect(body.data.rule.updatedAt).toBe('2024-06-16T00:00:00Z');
  });
});
