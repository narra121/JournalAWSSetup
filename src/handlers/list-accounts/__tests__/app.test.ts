import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBDocumentClient, QueryCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import type { APIGatewayProxyEventV2 } from 'aws-lambda';

// Mock environment variables before importing handler
vi.stubEnv('ACCOUNTS_TABLE', 'test-accounts');
vi.stubEnv('DAILY_STATS_TABLE', 'test-stats');

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
  ddbMock.on(QueryCommand, { TableName: 'test-stats' }).resolves({ Items: [] });
  ddbMock.on(UpdateCommand).resolves({});
});

describe('list-accounts handler', () => {
  // ── Success ─────────────────────────────────────────────────

  it('returns accounts with totalBalance and totalPnl', async () => {
    const items = [
      { userId: 'user-1', accountId: 'acc-1', name: 'Account 1', balance: 12000, initialBalance: 10000 },
      { userId: 'user-1', accountId: 'acc-2', name: 'Account 2', balance: 8000, initialBalance: 5000 },
    ];
    ddbMock.on(QueryCommand, { TableName: 'test-accounts' }).resolves({ Items: items });

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
    ddbMock.on(QueryCommand, { TableName: 'test-accounts' }).resolves({ Items: [] });

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
    ddbMock.on(QueryCommand, { TableName: 'test-accounts' }).resolves({ Items: items });

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
    ddbMock.on(QueryCommand, { TableName: 'test-accounts' }).rejects(new Error('DynamoDB timeout'));

    const res = await handler(makeEvent(), {} as any, () => {}) as any;

    expect(res.statusCode).toBe(500);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(false);
    expect(body.errorCode).toBe('INTERNAL_ERROR');
  });

  it('returns 500 with correct message when DynamoDB query fails', async () => {
    ddbMock.on(QueryCommand, { TableName: 'test-accounts' }).rejects(new Error('Throughput exceeded'));

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
    ddbMock.on(QueryCommand, { TableName: 'test-accounts' }).resolves({ Items: items });

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
    ddbMock.on(QueryCommand, { TableName: 'test-accounts' }).resolves({ Items: items });

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
    ddbMock.on(QueryCommand, { TableName: 'test-accounts' }).resolves({ Items: items });

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
    ddbMock.on(QueryCommand, { TableName: 'test-accounts' }).resolves({ Items: items });

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
    ddbMock.on(QueryCommand, { TableName: 'test-accounts' }).resolves({ Items: [] });

    const res = await handler(makeEvent(), {} as any, () => {}) as any;

    const body = JSON.parse(res.body);
    expect(body.success).toBe(true);
    expect(body.message).toBe('Accounts retrieved');
  });

  it('paginates through all DynamoDB results when LastEvaluatedKey is present', async () => {
    const page1Items = [
      { userId: 'user-1', accountId: 'acc-1', name: 'Account 1', balance: 10000, initialBalance: 8000 },
      { userId: 'user-1', accountId: 'acc-2', name: 'Account 2', balance: 5000, initialBalance: 5000 },
    ];
    const page2Items = [
      { userId: 'user-1', accountId: 'acc-3', name: 'Account 3', balance: 20000, initialBalance: 15000 },
    ];

    // First call returns page 1 with LastEvaluatedKey
    ddbMock.on(QueryCommand, { TableName: 'test-accounts' })
      .resolvesOnce({
        Items: page1Items,
        LastEvaluatedKey: { userId: 'user-1', accountId: 'acc-2' },
      })
      // Second call returns page 2 with no LastEvaluatedKey (end of data)
      .resolvesOnce({
        Items: page2Items,
      });

    const res = await handler(makeEvent(), {} as any, () => {}) as any;

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(true);
    // All 3 accounts from both pages should be returned
    expect(body.data.accounts).toHaveLength(3);
    expect(body.data.accounts[0].name).toBe('Account 1');
    expect(body.data.accounts[1].name).toBe('Account 2');
    expect(body.data.accounts[2].name).toBe('Account 3');
    // Totals should include both pages
    expect(body.data.totalBalance).toBe(35000); // 10000 + 5000 + 20000
    expect(body.data.totalPnl).toBe(7000); // (10000-8000) + (5000-5000) + (20000-15000)

    // Verify the accounts table was queried twice
    const queryCalls = ddbMock.commandCalls(QueryCommand).filter((c) => c.args[0].input.TableName === 'test-accounts');
    expect(queryCalls).toHaveLength(2);
    // Second call should have ExclusiveStartKey from the first response
    expect(queryCalls[1].args[0].input.ExclusiveStartKey).toEqual({ userId: 'user-1', accountId: 'acc-2' });
  });

  it('handles DynamoDB returning undefined Items (treated as empty)', async () => {
    ddbMock.on(QueryCommand, { TableName: 'test-accounts' }).resolves({ Items: undefined });

    const res = await handler(makeEvent(), {} as any, () => {}) as any;

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.data.accounts).toEqual([]);
    expect(body.data.totalBalance).toBe(0);
    expect(body.data.totalPnl).toBe(0);
  });

  // ── Currencies (BE-043) ─────────────────────────────────────

  it('never adds balances of different currencies: totals per currency, and no single total', async () => {
    ddbMock.on(QueryCommand, { TableName: 'test-accounts' }).resolves({ Items: [
      { userId: 'user-1', accountId: 'a', name: 'US', currency: 'USD', balance: 10000, initialBalance: 9000 },
      { userId: 'user-1', accountId: 'b', name: 'JP', currency: 'JPY', balance: 1500000, initialBalance: 1000000 },
      { userId: 'user-1', accountId: 'c', name: 'US2', currency: 'usd', balance: 500, initialBalance: 500 },
    ] });
    const res = await handler(makeEvent(), {} as any, () => {}) as any;
    const data = JSON.parse(res.body).data;
    expect(data.totalsByCurrency).toEqual({ USD: { balance: 10500, pnl: 1000 }, JPY: { balance: 1500000, pnl: 500000 } });
    expect(data.totalBalance).toBeUndefined();
    expect(data.totalPnl).toBeUndefined();
  });

  it('with one currency the single totals stay and match the per-currency block', async () => {
    ddbMock.on(QueryCommand, { TableName: 'test-accounts' }).resolves({ Items: [
      { userId: 'user-1', accountId: 'a', currency: 'INR', balance: 100, initialBalance: 80 },
      { userId: 'user-1', accountId: 'b', currency: 'INR', balance: 50, initialBalance: 50 },
    ] });
    const data = JSON.parse(((await handler(makeEvent(), {} as any, () => {})) as any).body).data;
    expect(data).toMatchObject({ totalBalance: 150, totalPnl: 20, totalsByCurrency: { INR: { balance: 150, pnl: 20 } } });
  });

  // ── Trade counts (M1) ───────────────────────────────────────

  describe('trade count per account', () => {
    const stored = (id: string, over: Record<string, any> = {}) => ({ userId: 'user-1', accountId: id, name: id.toUpperCase(), balance: 1, initialBalance: 1, ...over });
    const statsQueries = () => ddbMock.commandCalls(QueryCommand).map((c) => c.args[0].input).filter((i) => i.TableName === 'test-stats');
    const heals = () => ddbMock.commandCalls(UpdateCommand).map((c) => c.args[0].input);
    const accountsOf = async () => {
      const res = (await handler(makeEvent(), {} as any, () => {})) as any;
      return Object.fromEntries(JSON.parse(res.body).data.accounts.map((a: any) => [a.accountId, a]));
    };

    it('returns the stored tradeCount and lastTradeDate without touching DailyStats', async () => {
      ddbMock.on(QueryCommand, { TableName: 'test-accounts' }).resolves({ Items: [
        stored('a', { tradeCount: 8, lastTradeDate: '2026-11-10' }),
        stored('b', { tradeCount: 0 }),
      ] });

      const byId = await accountsOf();

      expect(byId.a).toMatchObject({ name: 'A', tradeCount: 8, lastTradeDate: '2026-11-10' });
      expect(byId.b).toMatchObject({ tradeCount: 0, lastTradeDate: null });
      expect(statsQueries()).toHaveLength(0);
      expect(heals()).toHaveLength(0);
    });

    it('an account created before the counters is summed from its own day records and stored once (no manual backfill)', async () => {
      ddbMock.on(QueryCommand, { TableName: 'test-accounts' }).resolves({ Items: [stored('a'), stored('b', { tradeCount: 3, lastTradeDate: '2026-09-01' })] });
      ddbMock.on(QueryCommand, { TableName: 'test-stats' }).resolves({ Items: [
        { date: '2026-11-03', tradeCount: 2 },
        { date: '2026-11-10', tradeCount: 5 },
        { date: '2026-10-30', tradeCount: 1 },
      ] });

      const byId = await accountsOf();

      expect(byId.a).toMatchObject({ tradeCount: 8, lastTradeDate: '2026-11-10' });
      expect(byId.b).toMatchObject({ tradeCount: 3, lastTradeDate: '2026-09-01' });
      // Only account a is read, by its sort-key range in the main table: not the whole user partition.
      expect(statsQueries()).toHaveLength(1);
      expect(statsQueries()[0]).toMatchObject({
        KeyConditionExpression: 'userId = :userId AND #sk BETWEEN :skStart AND :skEnd',
        ExpressionAttributeValues: { ':userId': 'user-1', ':skStart': 'a#0000-01-01', ':skEnd': 'a#9999-12-31' },
      });
      expect(statsQueries()[0].IndexName).toBeUndefined();
      expect(heals()).toHaveLength(1);
      expect(heals()[0]).toMatchObject({
        TableName: 'test-accounts',
        Key: { userId: 'user-1', accountId: 'a' },
        UpdateExpression: 'SET #tradeCount = :count, #lastTradeDate = :last',
        ConditionExpression: 'attribute_exists(userId) AND attribute_not_exists(#tradeCount)',
        ExpressionAttributeValues: { ':count': 8, ':last': '2026-11-10' },
      });
    });

    it('a legacy account without any day record gets 0 and null, and 0 is stored so it is not summed again', async () => {
      ddbMock.on(QueryCommand, { TableName: 'test-accounts' }).resolves({ Items: [stored('c')] });

      const byId = await accountsOf();

      expect(byId.c).toMatchObject({ tradeCount: 0, lastTradeDate: null });
      expect(heals()[0]).toMatchObject({ UpdateExpression: 'SET #tradeCount = :count', ExpressionAttributeValues: { ':count': 0 } });
    });

    it('follows the pages of the day records, and ignores rows without a positive count', async () => {
      ddbMock.on(QueryCommand, { TableName: 'test-accounts' }).resolves({ Items: [stored('a')] });
      ddbMock.on(QueryCommand, { TableName: 'test-stats' })
        .resolvesOnce({ Items: [{ date: '2026-11-03', tradeCount: 2 }, { date: '2026-12-01', tradeCount: 0 }], LastEvaluatedKey: { k: 1 } })
        .resolvesOnce({ Items: [{ date: '2026-11-04', tradeCount: 3 }, { date: '2026-12-02' }] });

      const byId = await accountsOf();

      expect(byId.a).toMatchObject({ tradeCount: 5, lastTradeDate: '2026-11-04' });
      expect(statsQueries()).toHaveLength(2);
    });

    it('does not fail the request when the counters cannot be stored, nor when another writer stored them first', async () => {
      ddbMock.on(QueryCommand, { TableName: 'test-accounts' }).resolves({ Items: [stored('a')] });
      ddbMock.on(QueryCommand, { TableName: 'test-stats' }).resolves({ Items: [{ date: '2026-11-03', tradeCount: 2 }] });

      ddbMock.on(UpdateCommand).rejects(Object.assign(new Error('raced'), { name: 'ConditionalCheckFailedException' }));
      expect((await accountsOf()).a).toMatchObject({ tradeCount: 2 });

      ddbMock.on(UpdateCommand).rejects(new Error('throttled'));
      expect((await accountsOf()).a).toMatchObject({ tradeCount: 2 });
    });

    it('leaves the other fields of the response as they were', async () => {
      ddbMock.on(QueryCommand, { TableName: 'test-accounts' }).resolves({ Items: [{ userId: 'user-1', accountId: 'a', currency: 'USD', balance: 7, initialBalance: 5, tradeCount: 0 }] });

      const data = JSON.parse(((await handler(makeEvent(), {} as any, () => {})) as any).body).data;

      expect(data.accounts).toEqual([{ userId: 'user-1', accountId: 'a', currency: 'USD', balance: 7, initialBalance: 5, tradeCount: 0, lastTradeDate: null }]);
      expect(data).toMatchObject({ totalBalance: 7, totalPnl: 2, totalsByCurrency: { USD: { balance: 7, pnl: 2 } } });
    });

    it('returns 500 when the day records of a legacy account cannot be read', async () => {
      ddbMock.on(QueryCommand, { TableName: 'test-accounts' }).resolves({ Items: [stored('a')] });
      ddbMock.on(QueryCommand, { TableName: 'test-stats' }).rejects(new Error('stats timeout'));

      const res = (await handler(makeEvent(), {} as any, () => {})) as any;

      expect(res.statusCode).toBe(500);
    });
  });
});
