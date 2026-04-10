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

  it('returns 500 with correct message when DynamoDB query fails', async () => {
    ddbMock.on(QueryCommand).rejects(new Error('Throughput exceeded'));

    const res = await handler(makeEvent(), {} as any, () => {}) as any;

    expect(res.statusCode).toBe(500);
    const body = JSON.parse(res.body);
    expect(body.message).toBe('Failed to retrieve accounts');
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

  // ── Balance calculations ───────────────────────────────────

  it('handles accounts with zero balance and zero initialBalance', async () => {
    const items = [
      { userId: 'user-1', accountId: 'acc-1', balance: 0, initialBalance: 0 },
    ];
    ddbMock.on(QueryCommand).resolves({ Items: items });

    const res = await handler(makeEvent(), {} as any, () => {}) as any;

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.data.totalBalance).toBe(0);
    expect(body.data.totalPnl).toBe(0);
  });

  it('handles accounts with missing balance and initialBalance fields', async () => {
    const items = [
      { userId: 'user-1', accountId: 'acc-1', name: 'Empty Account' },
    ];
    ddbMock.on(QueryCommand).resolves({ Items: items });

    const res = await handler(makeEvent(), {} as any, () => {}) as any;

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    // balance||0 = 0, initialBalance||0 = 0 => pnl = 0
    expect(body.data.totalBalance).toBe(0);
    expect(body.data.totalPnl).toBe(0);
    expect(body.data.accounts).toHaveLength(1);
  });

  it('handles accounts with negative PnL (loss exceeds initial balance)', async () => {
    const items = [
      { userId: 'user-1', accountId: 'acc-1', balance: 2000, initialBalance: 10000 },
    ];
    ddbMock.on(QueryCommand).resolves({ Items: items });

    const res = await handler(makeEvent(), {} as any, () => {}) as any;

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.data.totalBalance).toBe(2000);
    expect(body.data.totalPnl).toBe(-8000);
  });

  // ── Multiple accounts with different statuses ──────────────

  it('returns accounts with different statuses (active, breached, passed)', async () => {
    const items = [
      { userId: 'user-1', accountId: 'acc-1', name: 'Active', status: 'active', balance: 12000, initialBalance: 10000 },
      { userId: 'user-1', accountId: 'acc-2', name: 'Breached', status: 'breached', balance: 4000, initialBalance: 10000 },
      { userId: 'user-1', accountId: 'acc-3', name: 'Passed', status: 'passed', balance: 15000, initialBalance: 10000 },
    ];
    ddbMock.on(QueryCommand).resolves({ Items: items });

    const res = await handler(makeEvent(), {} as any, () => {}) as any;

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.data.accounts).toHaveLength(3);
    expect(body.data.accounts[0].status).toBe('active');
    expect(body.data.accounts[1].status).toBe('breached');
    expect(body.data.accounts[2].status).toBe('passed');
    expect(body.data.totalBalance).toBe(31000);
    expect(body.data.totalPnl).toBe(1000); // 2000 - 6000 + 5000
  });

  // ── Response shape ─────────────────────────────────────────

  it('response body contains success true and message "Accounts retrieved"', async () => {
    ddbMock.on(QueryCommand).resolves({ Items: [] });

    const res = await handler(makeEvent(), {} as any, () => {}) as any;

    const body = JSON.parse(res.body);
    expect(body.success).toBe(true);
    expect(body.message).toBe('Accounts retrieved');
  });

  it('handles DynamoDB returning undefined Items (treated as empty)', async () => {
    ddbMock.on(QueryCommand).resolves({ Items: undefined });

    const res = await handler(makeEvent(), {} as any, () => {}) as any;

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.data.accounts).toEqual([]);
    expect(body.data.totalBalance).toBe(0);
    expect(body.data.totalPnl).toBe(0);
  });
});
