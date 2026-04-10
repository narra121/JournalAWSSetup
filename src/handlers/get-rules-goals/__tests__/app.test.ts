import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBDocumentClient, QueryCommand, BatchWriteCommand } from '@aws-sdk/lib-dynamodb';
import type { APIGatewayProxyEventV2 } from 'aws-lambda';

vi.stubEnv('RULES_TABLE', 'test-rules');
vi.stubEnv('GOALS_TABLE', 'test-goals');

const ddbMock = mockClient(DynamoDBDocumentClient);

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
    routeKey: 'GET /rules-goals',
    rawPath: '/rules-goals',
    rawQueryString: '',
    headers: {
      authorization: `Bearer ${makeJwt('user-1')}`,
    },
    requestContext: {
      accountId: '123',
      apiId: 'api',
      domainName: 'api.example.com',
      domainPrefix: 'api',
      http: { method: 'GET', path: '/rules-goals', protocol: 'HTTP/1.1', sourceIp: '127.0.0.1', userAgent: 'test' },
      requestId: 'req-1',
      routeKey: 'GET /rules-goals',
      stage: '$default',
      time: '01/Jan/2024:00:00:00 +0000',
      timeEpoch: 0,
    },
    isBase64Encoded: false,
    ...overrides,
  } as unknown as APIGatewayProxyEventV2;
}

const existingRules = [
  { userId: 'user-1', ruleId: 'r1', rule: 'Never risk more than 1%', completed: false, isActive: true },
  { userId: 'user-1', ruleId: 'r2', rule: 'Always set stop loss', completed: true, isActive: true },
];

const existingGoals = [
  { userId: 'user-1', goalId: 'g1', title: 'Monthly profit target', target: 5000, period: 'monthly' },
  { userId: 'user-1', goalId: 'g2', title: 'Win rate above 60%', target: 60, period: 'weekly' },
];

// ─── Tests ──────────────────────────────────────────────────────

beforeEach(() => {
  ddbMock.reset();
});

describe('get-rules-goals handler', () => {
  // ── Success ─────────────────────────────────────────────────

  it('returns existing rules and goals with meta counts', async () => {
    ddbMock.on(QueryCommand)
      .resolvesOnce({ Items: existingRules })
      .resolvesOnce({ Items: existingGoals });

    const res = await handler(makeEvent(), {} as any, () => {}) as any;

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(true);
    expect(body.data.rules).toHaveLength(2);
    expect(body.data.goals).toHaveLength(2);
    expect(body.data.meta.rulesCount).toBe(2);
    expect(body.data.meta.goalsCount).toBe(2);
  });

  it('creates default rules when user has none', async () => {
    ddbMock.on(QueryCommand)
      .resolvesOnce({ Items: [] })          // rules query returns empty
      .resolvesOnce({ Items: existingGoals }); // goals query returns data
    ddbMock.on(BatchWriteCommand).resolves({ UnprocessedItems: {} });

    const res = await handler(makeEvent(), {} as any, () => {}) as any;

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(true);
    // Default rules should have been created (6 default rules)
    expect(body.data.rules.length).toBe(6);
    expect(body.data.meta.rulesCount).toBe(6);
    // Verify BatchWriteCommand was called to persist default rules
    const batchCalls = ddbMock.commandCalls(BatchWriteCommand);
    expect(batchCalls.length).toBeGreaterThanOrEqual(1);
  });

  // ── Auth errors ─────────────────────────────────────────────

  it('returns 401 when authorization header is missing', async () => {
    const event = makeEvent({ headers: {} });
    const res = await handler(event, {} as any, () => {}) as any;

    expect(res.statusCode).toBe(401);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(false);
    expect(body.errorCode).toBe('UNAUTHORIZED');
  });

  // ── DynamoDB errors ─────────────────────────────────────────

  it('returns 500 when DynamoDB fails', async () => {
    ddbMock.on(QueryCommand).rejects(new Error('DynamoDB error'));

    const res = await handler(makeEvent(), {} as any, () => {}) as any;

    expect(res.statusCode).toBe(500);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(false);
    expect(body.errorCode).toBe('INTERNAL_ERROR');
  });

  // ── Additional coverage ─────────────────────────────────────

  it('returns existing rules with empty goals', async () => {
    ddbMock.on(QueryCommand)
      .resolvesOnce({ Items: existingRules })
      .resolvesOnce({ Items: [] });

    const res = await handler(makeEvent(), {} as any, () => {}) as any;

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.data.rules).toHaveLength(2);
    expect(body.data.goals).toEqual([]);
    expect(body.data.meta.rulesCount).toBe(2);
    expect(body.data.meta.goalsCount).toBe(0);
  });

  it('creates default rules when no rules exist and returns empty goals', async () => {
    ddbMock.on(QueryCommand)
      .resolvesOnce({ Items: [] })
      .resolvesOnce({ Items: [] });
    ddbMock.on(BatchWriteCommand).resolves({ UnprocessedItems: {} });

    const res = await handler(makeEvent(), {} as any, () => {}) as any;

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.data.rules).toHaveLength(6);
    expect(body.data.goals).toEqual([]);
    expect(body.data.meta.rulesCount).toBe(6);
    expect(body.data.meta.goalsCount).toBe(0);
  });

  it('returns 401 when authorization token is malformed', async () => {
    const event = makeEvent({ headers: { authorization: 'Bearer not-a-jwt' } });
    const res = await handler(event, {} as any, () => {}) as any;

    expect(res.statusCode).toBe(401);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(false);
    expect(body.errorCode).toBe('UNAUTHORIZED');
  });

  it('returns 500 when rules query fails but goals would succeed', async () => {
    ddbMock.on(QueryCommand)
      .resolvesOnce(Promise.reject(new Error('Rules query failed')))
      .resolvesOnce({ Items: existingGoals });

    const res = await handler(makeEvent(), {} as any, () => {}) as any;

    expect(res.statusCode).toBe(500);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(false);
    expect(body.errorCode).toBe('INTERNAL_ERROR');
  });

  it('returns 500 when goals query fails but rules would succeed', async () => {
    ddbMock.on(QueryCommand)
      .resolvesOnce({ Items: existingRules })
      .resolvesOnce(Promise.reject(new Error('Goals query failed')));

    const res = await handler(makeEvent(), {} as any, () => {}) as any;

    expect(res.statusCode).toBe(500);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(false);
    expect(body.errorCode).toBe('INTERNAL_ERROR');
  });

  it('queries DynamoDB with correct userId from JWT', async () => {
    ddbMock.on(QueryCommand)
      .resolvesOnce({ Items: [] })
      .resolvesOnce({ Items: [] });
    ddbMock.on(BatchWriteCommand).resolves({ UnprocessedItems: {} });

    const event = makeEvent({
      headers: { authorization: `Bearer ${makeJwt('user-99')}` },
    });
    const res = await handler(event, {} as any, () => {}) as any;

    expect(res.statusCode).toBe(200);
    const queryCalls = ddbMock.commandCalls(QueryCommand);
    expect(queryCalls).toHaveLength(2);
    expect(queryCalls[0].args[0].input.ExpressionAttributeValues).toEqual({ ':userId': 'user-99' });
    expect(queryCalls[1].args[0].input.ExpressionAttributeValues).toEqual({ ':userId': 'user-99' });
  });

  it('handles Items being undefined in both query results', async () => {
    ddbMock.on(QueryCommand)
      .resolvesOnce({ Items: undefined })
      .resolvesOnce({ Items: undefined });
    ddbMock.on(BatchWriteCommand).resolves({ UnprocessedItems: {} });

    const res = await handler(makeEvent(), {} as any, () => {}) as any;

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    // Should create default rules since no rules exist
    expect(body.data.rules).toHaveLength(6);
    expect(body.data.goals).toEqual([]);
  });

  it('response includes success message', async () => {
    ddbMock.on(QueryCommand)
      .resolvesOnce({ Items: existingRules })
      .resolvesOnce({ Items: existingGoals });

    const res = await handler(makeEvent(), {} as any, () => {}) as any;

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.message).toBe('Rules and goals retrieved');
  });

  it('returns 500 when DynamoDB throws ProvisionedThroughputExceededException', async () => {
    const awsError = new Error('Throughput exceeded');
    awsError.name = 'ProvisionedThroughputExceededException';
    ddbMock.on(QueryCommand).rejects(awsError);

    const res = await handler(makeEvent(), {} as any, () => {}) as any;

    expect(res.statusCode).toBe(500);
    const body = JSON.parse(res.body);
    expect(body.errorCode).toBe('INTERNAL_ERROR');
  });
});
