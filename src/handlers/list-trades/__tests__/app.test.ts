import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBDocumentClient, QueryCommand } from '@aws-sdk/lib-dynamodb';
import type { APIGatewayProxyEventV2 } from 'aws-lambda';

// Mock environment variables before importing handler
vi.stubEnv('TRADES_TABLE', 'test-trades');
vi.stubEnv('IMAGES_BUCKET', 'test-bucket');

// Must import handler after env stubs
const { handler } = await import('../app.ts');

const ddbMock = mockClient(DynamoDBDocumentClient);

// ─── Helpers ────────────────────────────────────────────────────

function makeJwt(sub: string): string {
  const header = btoa(JSON.stringify({ alg: 'RS256' }));
  const payload = btoa(JSON.stringify({ sub }));
  return `${header}.${payload}.sig`;
}

function makeEvent(overrides: Partial<APIGatewayProxyEventV2> = {}): APIGatewayProxyEventV2 {
  return {
    version: '2.0',
    routeKey: 'GET /trades',
    rawPath: '/trades',
    rawQueryString: '',
    headers: {
      authorization: `Bearer ${makeJwt('user-1')}`,
    },
    requestContext: {
      accountId: '123',
      apiId: 'api',
      domainName: 'api.example.com',
      domainPrefix: 'api',
      http: { method: 'GET', path: '/trades', protocol: 'HTTP/1.1', sourceIp: '127.0.0.1', userAgent: 'test' },
      requestId: 'req-1',
      routeKey: 'GET /trades',
      stage: '$default',
      time: '01/Jan/2024:00:00:00 +0000',
      timeEpoch: 0,
    },
    queryStringParameters: {
      accountId: 'acc-1',
      startDate: '2024-01-01',
      endDate: '2024-12-31',
    },
    isBase64Encoded: false,
    ...overrides,
  } as APIGatewayProxyEventV2;
}

// ─── Tests ──────────────────────────────────────────────────────

beforeEach(() => {
  ddbMock.reset();
});

describe('list-trades handler', () => {
  it('returns trades for authenticated user', async () => {
    const items = [
      { userId: 'user-1', tradeId: 't1', symbol: 'AAPL', side: 'BUY', openDate: '2024-01-10', images: [] },
      { userId: 'user-1', tradeId: 't2', symbol: 'MSFT', side: 'SELL', openDate: '2024-02-15', images: [] },
    ];
    ddbMock.on(QueryCommand).resolves({ Items: items });

    const res = await handler(makeEvent(), {} as any, () => {}) as any;

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(true);
    expect(body.data.trades).toHaveLength(2);
    expect(body.data.trades[0].symbol).toBe('AAPL');
  });

  it('returns empty list when no trades exist', async () => {
    ddbMock.on(QueryCommand).resolves({ Items: [] });

    const res = await handler(makeEvent(), {} as any, () => {}) as any;

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.data.trades).toEqual([]);
  });

  it('returns 401 when authorization header is missing', async () => {
    const event = makeEvent({ headers: {} });
    const res = await handler(event, {} as any, () => {}) as any;

    expect(res.statusCode).toBe(401);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(false);
    expect(body.errorCode).toBe('UNAUTHORIZED');
  });

  it('returns 400 when accountId is missing', async () => {
    const event = makeEvent({
      queryStringParameters: {
        startDate: '2024-01-01',
        endDate: '2024-12-31',
      },
    });
    const res = await handler(event, {} as any, () => {}) as any;

    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.errorCode).toBe('VALIDATION_ERROR');
    expect(body.message).toContain('accountId');
  });

  it('returns 400 when date params are missing', async () => {
    const event = makeEvent({
      queryStringParameters: {
        accountId: 'acc-1',
      },
    });
    const res = await handler(event, {} as any, () => {}) as any;

    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.errorCode).toBe('VALIDATION_ERROR');
    expect(body.message).toContain('startDate');
  });

  it('returns nextToken when DynamoDB returns LastEvaluatedKey', async () => {
    const lastKey = { userId: 'user-1', tradeId: 't5' };
    ddbMock.on(QueryCommand).resolves({
      Items: [{ userId: 'user-1', tradeId: 't5', symbol: 'TSLA', images: [] }],
      LastEvaluatedKey: lastKey,
    });

    const res = await handler(makeEvent(), {} as any, () => {}) as any;

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.data.nextToken).toBeDefined();
    // Decode the nextToken and verify it matches the LastEvaluatedKey
    const decoded = JSON.parse(Buffer.from(body.data.nextToken, 'base64').toString('utf-8'));
    expect(decoded).toEqual(lastKey);
  });

  it('handles DynamoDB errors gracefully', async () => {
    ddbMock.on(QueryCommand).rejects(new Error('DynamoDB timeout'));

    const res = await handler(makeEvent(), {} as any, () => {}) as any;

    expect(res.statusCode).toBe(500);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(false);
    expect(body.errorCode).toBe('INTERNAL_ERROR');
  });

  it('normalizes image keys in trade items', async () => {
    const items = [
      {
        userId: 'user-1',
        tradeId: 't1',
        symbol: 'AAPL',
        images: [{ key: 'images/user-1/t1/img1.jpg', timeframe: '1h' }],
      },
    ];
    ddbMock.on(QueryCommand).resolves({ Items: items });

    const res = await handler(makeEvent(), {} as any, () => {}) as any;

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    const img = body.data.trades[0].images[0];
    expect(img.id).toBe('images/user-1/t1/img1.jpg');
    expect(img.key).toBe('images/user-1/t1/img1.jpg');
  });

  it('queries with accountId=ALL skips account filtering', async () => {
    ddbMock.on(QueryCommand).resolves({ Items: [] });

    const event = makeEvent({
      queryStringParameters: {
        accountId: 'ALL',
        startDate: '2024-01-01',
        endDate: '2024-12-31',
      },
    });
    await handler(event, {} as any, () => {}) as any;

    // Verify the query was sent - it should NOT have a FilterExpression for accountId
    const call = ddbMock.commandCalls(QueryCommand)[0];
    expect(call.args[0].input.FilterExpression).toBeUndefined();
  });
});
