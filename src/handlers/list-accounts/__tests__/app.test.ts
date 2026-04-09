import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBDocumentClient, QueryCommand } from '@aws-sdk/lib-dynamodb';
import type { APIGatewayProxyEventV2 } from 'aws-lambda';

// Mock environment variables before importing handler
vi.stubEnv('ACCOUNTS_TABLE', 'test-accounts');

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
    routeKey: 'GET /accounts',
    rawPath: '/accounts',
    rawQueryString: '',
    headers: {
      authorization: `Bearer ${makeJwt('user-1')}`,
    },
    requestContext: {
      accountId: '123',
      apiId: 'api',
      domainName: 'api.example.com',
      domainPrefix: 'api',
      http: { method: 'GET', path: '/accounts', protocol: 'HTTP/1.1', sourceIp: '127.0.0.1', userAgent: 'test' },
      requestId: 'req-1',
      routeKey: 'GET /accounts',
      stage: '$default',
      time: '01/Jan/2024:00:00:00 +0000',
      timeEpoch: 0,
    },
    isBase64Encoded: false,
    ...overrides,
  } as APIGatewayProxyEventV2;
}

// ─── Tests ──────────────────────────────────────────────────────

beforeEach(() => {
  ddbMock.reset();
});

describe('list-accounts handler', () => {
  // ── Success ─────────────────────────────────────────────────

  it('returns accounts with totalBalance and totalPnl', async () => {
    const items = [
      { userId: 'user-1', accountId: 'acc-1', name: 'Account 1', balance: 12000, initialBalance: 10000 },
      { userId: 'user-1', accountId: 'acc-2', name: 'Account 2', balance: 8000, initialBalance: 5000 },
    ];
    ddbMock.on(QueryCommand).resolves({ Items: items });

    const res = await handler(makeEvent(), {} as any, () => {}) as any;

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(true);
    expect(body.data.accounts).toHaveLength(2);
    expect(body.data.accounts[0].name).toBe('Account 1');
    expect(body.data.accounts[1].name).toBe('Account 2');
    expect(body.data.totalBalance).toBe(20000);
    expect(body.data.totalPnl).toBe(5000);
  });

  it('returns empty list with zero totals when no accounts exist', async () => {
    ddbMock.on(QueryCommand).resolves({ Items: [] });

    const res = await handler(makeEvent(), {} as any, () => {}) as any;

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(true);
    expect(body.data.accounts).toEqual([]);
    expect(body.data.totalBalance).toBe(0);
    expect(body.data.totalPnl).toBe(0);
  });

  it('calculates correct totalBalance and totalPnl with mixed gains and losses', async () => {
    const items = [
      { userId: 'user-1', accountId: 'acc-1', balance: 15000, initialBalance: 10000 },  // +5000 pnl
      { userId: 'user-1', accountId: 'acc-2', balance: 3000, initialBalance: 5000 },     // -2000 pnl
      { userId: 'user-1', accountId: 'acc-3', balance: 7500, initialBalance: 7500 },     // 0 pnl
    ];
    ddbMock.on(QueryCommand).resolves({ Items: items });

    const res = await handler(makeEvent(), {} as any, () => {}) as any;

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.data.totalBalance).toBe(25500);
    expect(body.data.totalPnl).toBe(3000); // 5000 - 2000 + 0
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

  it('returns 500 when DynamoDB query fails', async () => {
    ddbMock.on(QueryCommand).rejects(new Error('DynamoDB timeout'));

    const res = await handler(makeEvent(), {} as any, () => {}) as any;

    expect(res.statusCode).toBe(500);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(false);
    expect(body.errorCode).toBe('INTERNAL_ERROR');
  });
});
