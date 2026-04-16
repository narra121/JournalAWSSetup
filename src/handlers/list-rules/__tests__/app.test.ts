import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBDocumentClient, QueryCommand } from '@aws-sdk/lib-dynamodb';
import type { APIGatewayProxyEventV2 } from 'aws-lambda';

vi.stubEnv('RULES_TABLE', 'test-rules');

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
    routeKey: 'GET /rules',
    rawPath: '/rules',
    rawQueryString: '',
    headers: {
      authorization: `Bearer ${makeJwt('user-1')}`,
    },
    requestContext: {
      accountId: '123',
      apiId: 'api',
      domainName: 'api.example.com',
      domainPrefix: 'api',
      http: { method: 'GET', path: '/rules', protocol: 'HTTP/1.1', sourceIp: '127.0.0.1', userAgent: 'test' },
      requestId: 'req-1',
      routeKey: 'GET /rules',
      stage: '$default',
      time: '01/Jan/2024:00:00:00 +0000',
      timeEpoch: 0,
    },
    isBase64Encoded: false,
    ...overrides,
  } as unknown as APIGatewayProxyEventV2;
}

// ─── Tests ──────────────────────────────────────────────────────

beforeEach(() => {
  ddbMock.reset();
});

describe('list-rules handler', () => {
  // ── Success ─────────────────────────────────────────────────

  it('returns rules for authenticated user', async () => {
    const items = [
      { userId: 'user-1', ruleId: 'r1', rule: 'Never risk more than 1%', completed: false, isActive: true },
      { userId: 'user-1', ruleId: 'r2', rule: 'Always set stop loss', completed: true, isActive: true },
    ];
    ddbMock.on(QueryCommand).resolves({ Items: items });

    const res = await handler(makeEvent(), {} as any, () => {}) as any;

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(true);
    expect(body.data.rules).toHaveLength(2);
    expect(body.data.rules[0].rule).toBe('Never risk more than 1%');
  });

  it('returns empty list when no rules exist', async () => {
    ddbMock.on(QueryCommand).resolves({ Items: [] });

    const res = await handler(makeEvent(), {} as any, () => {}) as any;

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.data.rules).toEqual([]);
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
    ddbMock.on(QueryCommand).rejects(new Error('DynamoDB timeout'));

    const res = await handler(makeEvent(), {} as any, () => {}) as any;

    expect(res.statusCode).toBe(500);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(false);
    expect(body.errorCode).toBe('INTERNAL_ERROR');
  });

  // ── Additional coverage ─────────────────────────────────────

  it('returns rules with correct structure when Items is undefined', async () => {
    ddbMock.on(QueryCommand).resolves({ Items: undefined });

    const res = await handler(makeEvent(), {} as any, () => {}) as any;

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(true);
    expect(body.data.rules).toEqual([]);
  });

  it('returns multiple rules preserving all fields', async () => {
    const items = [
      { userId: 'user-1', ruleId: 'r1', rule: 'Rule A', completed: false, isActive: true, createdAt: '2024-01-01T00:00:00Z', updatedAt: '2024-01-01T00:00:00Z' },
      { userId: 'user-1', ruleId: 'r2', rule: 'Rule B', completed: true, isActive: false, createdAt: '2024-01-02T00:00:00Z', updatedAt: '2024-01-02T00:00:00Z' },
      { userId: 'user-1', ruleId: 'r3', rule: 'Rule C', completed: false, isActive: true, createdAt: '2024-01-03T00:00:00Z', updatedAt: '2024-01-03T00:00:00Z' },
    ];
    ddbMock.on(QueryCommand).resolves({ Items: items });

    const res = await handler(makeEvent(), {} as any, () => {}) as any;

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.data.rules).toHaveLength(3);
    expect(body.data.rules[0].ruleId).toBe('r1');
    expect(body.data.rules[1].ruleId).toBe('r2');
    expect(body.data.rules[2].ruleId).toBe('r3');
    expect(body.data.rules[1].completed).toBe(true);
    expect(body.data.rules[1].isActive).toBe(false);
  });

  it('queries DynamoDB with the correct userId from JWT', async () => {
    ddbMock.on(QueryCommand).resolves({ Items: [] });

    const event = makeEvent({
      headers: { authorization: `Bearer ${makeJwt('user-42')}` },
    });
    const res = await handler(event, {} as any, () => {}) as any;

    expect(res.statusCode).toBe(200);
    const queryCalls = ddbMock.commandCalls(QueryCommand);
    expect(queryCalls).toHaveLength(1);
    expect(queryCalls[0].args[0].input.ExpressionAttributeValues).toEqual({ ':userId': 'user-42' });
  });

  it('does not return rules belonging to a different user', async () => {
    // Only user-1's rules should be queried; the mock verifies the userId filter
    ddbMock.on(QueryCommand).callsFake((input) => {
      expect(input.ExpressionAttributeValues[':userId']).toBe('user-1');
      return { Items: [{ userId: 'user-1', ruleId: 'r1', rule: 'My rule' }] };
    });

    const res = await handler(makeEvent(), {} as any, () => {}) as any;

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.data.rules).toHaveLength(1);
    expect(body.data.rules[0].userId).toBe('user-1');
  });

  it('returns 500 when DynamoDB QueryCommand throws a specific AWS error', async () => {
    const awsError = new Error('Throughput exceeded');
    awsError.name = 'ProvisionedThroughputExceededException';
    ddbMock.on(QueryCommand).rejects(awsError);

    const res = await handler(makeEvent(), {} as any, () => {}) as any;

    expect(res.statusCode).toBe(500);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(false);
    expect(body.errorCode).toBe('INTERNAL_ERROR');
  });

  it('handles rules with missing optional fields gracefully', async () => {
    const items = [
      { userId: 'user-1', ruleId: 'r1', rule: 'Minimal rule' },
    ];
    ddbMock.on(QueryCommand).resolves({ Items: items });

    const res = await handler(makeEvent(), {} as any, () => {}) as any;

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.data.rules).toHaveLength(1);
    expect(body.data.rules[0].rule).toBe('Minimal rule');
    expect(body.data.rules[0].completed).toBeUndefined();
    expect(body.data.rules[0].isActive).toBeUndefined();
  });

  it('returns 401 when authorization token is malformed', async () => {
    const event = makeEvent({ headers: { authorization: 'Bearer not-a-jwt' } });
    const res = await handler(event, {} as any, () => {}) as any;

    expect(res.statusCode).toBe(401);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(false);
    expect(body.errorCode).toBe('UNAUTHORIZED');
  });

  it('handles a large result set', async () => {
    const items = Array.from({ length: 100 }, (_, i) => ({
      userId: 'user-1',
      ruleId: `r${i}`,
      rule: `Rule number ${i}`,
      completed: i % 2 === 0,
      isActive: true,
    }));
    ddbMock.on(QueryCommand).resolves({ Items: items });

    const res = await handler(makeEvent(), {} as any, () => {}) as any;

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.data.rules).toHaveLength(100);
  });

  it('paginates through all DynamoDB results when LastEvaluatedKey is present', async () => {
    const page1Items = [
      { userId: 'user-1', ruleId: 'r1', rule: 'Rule from page 1a', completed: false, isActive: true },
      { userId: 'user-1', ruleId: 'r2', rule: 'Rule from page 1b', completed: true, isActive: true },
    ];
    const page2Items = [
      { userId: 'user-1', ruleId: 'r3', rule: 'Rule from page 2', completed: false, isActive: true },
    ];

    // First call returns page 1 with LastEvaluatedKey
    ddbMock.on(QueryCommand)
      .resolvesOnce({
        Items: page1Items,
        LastEvaluatedKey: { userId: 'user-1', ruleId: 'r2' },
      })
      // Second call returns page 2 with no LastEvaluatedKey (end of data)
      .resolvesOnce({
        Items: page2Items,
      });

    const res = await handler(makeEvent(), {} as any, () => {}) as any;

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(true);
    // All 3 rules from both pages should be returned
    expect(body.data.rules).toHaveLength(3);
    expect(body.data.rules[0].rule).toBe('Rule from page 1a');
    expect(body.data.rules[1].rule).toBe('Rule from page 1b');
    expect(body.data.rules[2].rule).toBe('Rule from page 2');

    // Verify DynamoDB was called twice
    const queryCalls = ddbMock.commandCalls(QueryCommand);
    expect(queryCalls).toHaveLength(2);
    // Second call should have ExclusiveStartKey from the first response
    expect(queryCalls[1].args[0].input.ExclusiveStartKey).toEqual({ userId: 'user-1', ruleId: 'r2' });
  });

  it('response body includes success message', async () => {
    ddbMock.on(QueryCommand).resolves({ Items: [] });

    const res = await handler(makeEvent(), {} as any, () => {}) as any;

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.message).toBe('Rules retrieved');
  });
});
