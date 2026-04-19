import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBDocumentClient, QueryCommand, BatchGetCommand } from '@aws-sdk/lib-dynamodb';

// Stub env before importing handler
vi.stubEnv('DAILY_STATS_TABLE', 'test-daily-stats');
vi.stubEnv('TRADES_TABLE', 'test-trades');

const ddbMock = mockClient(DynamoDBDocumentClient);

const { handler } = await import('../app.ts');

// --- Helpers ----------------------------------------------------------------

function makeJwt(sub: string): string {
  const header = btoa(JSON.stringify({ alg: 'RS256' }));
  const payload = btoa(JSON.stringify({ sub }));
  return `${header}.${payload}.sig`;
}

function makeEvent(body: Record<string, any> = {}): any {
  const jwt = makeJwt('test-user-id');
  return {
    requestContext: {
      requestId: 'test-req',
      authorizer: { jwt: { claims: { sub: 'test-user-id' } } },
    },
    headers: { authorization: `Bearer ${jwt}` },
    body: JSON.stringify(body),
  };
}

function makeUnauthEvent(body: Record<string, any> = {}): any {
  return {
    requestContext: { requestId: 'test-req', authorizer: {} },
    headers: {},
    body: JSON.stringify(body),
  };
}

/** Build a mock DailyStats record with a tradeHash. */
function makeDailyRecord(overrides: Record<string, any> = {}) {
  return {
    userId: 'test-user-id',
    sk: 'acc-1#2026-04-06',
    accountId: 'acc-1',
    date: '2026-04-06',
    dayOfWeek: 1,
    lastUpdated: '2026-04-06T12:00:00Z',
    tradeCount: 3,
    tradeHash: 'hash-abc-123',
    ...overrides,
  };
}

function makeTrade(overrides: Record<string, any> = {}) {
  return {
    userId: 'test-user-id',
    tradeId: 't1',
    symbol: 'AAPL',
    accountId: 'acc-1',
    openDate: '2026-04-06',
    ...overrides,
  };
}

// --- Tests ------------------------------------------------------------------

beforeEach(() => {
  ddbMock.reset();
});

describe('sync-trades handler', () => {
  // 1. Returns 401 for unauthenticated request
  it('returns 401 for unauthenticated request', async () => {
    const res = await handler(
      makeUnauthEvent({ accountId: 'acc-1', startDate: '2026-04-01', endDate: '2026-04-30', clientHashes: {} }),
      {} as any, () => {},
    ) as any;

    expect(res.statusCode).toBe(401);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(false);
    expect(body.errorCode).toBe('UNAUTHORIZED');
  });

  // 2. Returns 400 for missing accountId
  it('returns 400 for missing accountId', async () => {
    const res = await handler(
      makeEvent({ startDate: '2026-04-01', endDate: '2026-04-30', clientHashes: {} }),
      {} as any, () => {},
    ) as any;

    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(false);
    expect(body.errorCode).toBe('VALIDATION_ERROR');
    expect(body.message).toContain('accountId');
  });

  // 3. Returns 400 for missing startDate/endDate
  it('returns 400 for missing startDate and endDate', async () => {
    const res = await handler(
      makeEvent({ accountId: 'acc-1', clientHashes: {} }),
      {} as any, () => {},
    ) as any;

    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(false);
    expect(body.errorCode).toBe('VALIDATION_ERROR');
    expect(body.message).toContain('startDate');
  });

  // 4. Returns 400 for invalid JSON body
  it('returns 400 for invalid JSON body', async () => {
    const event = {
      requestContext: {
        requestId: 'test-req',
        authorizer: { jwt: { claims: { sub: 'test-user-id' } } },
      },
      headers: { authorization: `Bearer ${makeJwt('test-user-id')}` },
      body: '{invalid json!!!',
    };

    const res = await handler(event as any, {} as any, () => {}) as any;

    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(false);
    expect(body.errorCode).toBe('VALIDATION_ERROR');
    expect(body.message).toContain('Invalid JSON');
  });

  // 5. Empty clientHashes -> all days stale -> returns all hashes + trades
  it('returns all days as stale when clientHashes is empty', async () => {
    const record1 = makeDailyRecord({ date: '2026-04-06', sk: 'acc-1#2026-04-06', tradeHash: 'hash-1' });
    const record2 = makeDailyRecord({ date: '2026-04-07', sk: 'acc-1#2026-04-07', tradeHash: 'hash-2' });

    // Chain all QueryCommand responses: 1st = DailyStats, 2nd+3rd = trades GSI per stale day
    ddbMock.on(QueryCommand)
      .resolvesOnce({ Items: [record1, record2] })  // querySingleAccount
      .resolvesOnce({ Items: [{ userId: 'test-user-id', tradeId: 't1', openDate: '2026-04-06' }] })  // fetchTradesForDays day 1
      .resolvesOnce({ Items: [{ userId: 'test-user-id', tradeId: 't2', openDate: '2026-04-07' }] }); // fetchTradesForDays day 2

    const trade1 = makeTrade({ tradeId: 't1', openDate: '2026-04-06' });
    const trade2 = makeTrade({ tradeId: 't2', openDate: '2026-04-07' });
    ddbMock.on(BatchGetCommand).resolves({
      Responses: { 'test-trades': [trade1, trade2] },
    });

    const res = await handler(
      makeEvent({ accountId: 'acc-1', startDate: '2026-04-01', endDate: '2026-04-30', clientHashes: {} }),
      {} as any, () => {},
    ) as any;

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(true);
    expect(body.data.serverHashes).toBeDefined();
    expect(body.data.serverHashes['2026-04-06']).toBe('hash-1');
    expect(body.data.serverHashes['2026-04-07']).toBe('hash-2');
    expect(body.data.staleDays).toEqual(['2026-04-06', '2026-04-07']);
    expect(body.data.trades.length).toBeGreaterThanOrEqual(1);
  });

  // 6. All hashes match -> empty staleDays + empty trades
  it('returns empty staleDays and trades when all hashes match', async () => {
    const record = makeDailyRecord({ date: '2026-04-06', tradeHash: 'matching-hash' });
    ddbMock.on(QueryCommand).resolves({ Items: [record] });

    const res = await handler(
      makeEvent({
        accountId: 'acc-1',
        startDate: '2026-04-01',
        endDate: '2026-04-30',
        clientHashes: { '2026-04-06': 'matching-hash' },
      }),
      {} as any, () => {},
    ) as any;

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.data.staleDays).toEqual([]);
    expect(body.data.trades).toEqual([]);
  });

  // 7. Partial mismatch -> only stale trades returned
  it('returns only stale days when there is a partial hash mismatch', async () => {
    const record1 = makeDailyRecord({ date: '2026-04-06', sk: 'acc-1#2026-04-06', tradeHash: 'hash-1' });
    const record2 = makeDailyRecord({ date: '2026-04-07', sk: 'acc-1#2026-04-07', tradeHash: 'hash-2-changed' });

    // Chain: 1st = DailyStats query, 2nd = fetchTradesForDays GSI for stale day
    ddbMock.on(QueryCommand)
      .resolvesOnce({ Items: [record1, record2] })
      .resolvesOnce({ Items: [{ userId: 'test-user-id', tradeId: 't2', openDate: '2026-04-07' }] });

    const trade = makeTrade({ tradeId: 't2', openDate: '2026-04-07' });
    ddbMock.on(BatchGetCommand).resolves({ Responses: { 'test-trades': [trade] } });

    const res = await handler(
      makeEvent({
        accountId: 'acc-1',
        startDate: '2026-04-01',
        endDate: '2026-04-30',
        clientHashes: { '2026-04-06': 'hash-1', '2026-04-07': 'hash-2-old' },
      }),
      {} as any, () => {},
    ) as any;

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.data.staleDays).toEqual(['2026-04-07']);
    expect(body.data.trades).toHaveLength(1);
    expect(body.data.trades[0].tradeId).toBe('t2');
  });

  // 8. Day in server not in client -> stale
  it('marks day in server but not in client as stale', async () => {
    const record = makeDailyRecord({ date: '2026-04-10', sk: 'acc-1#2026-04-10', tradeHash: 'server-hash' });

    // Chain: 1st = DailyStats query, 2nd = fetchTradesForDays GSI for stale days
    ddbMock.on(QueryCommand)
      .resolvesOnce({ Items: [record] })
      .resolvesOnce({ Items: [{ userId: 'test-user-id', tradeId: 't3', openDate: '2026-04-10' }] })
      .resolvesOnce({ Items: [] }); // for the client-only day 2026-04-06

    ddbMock.on(BatchGetCommand).resolves({
      Responses: { 'test-trades': [makeTrade({ tradeId: 't3', openDate: '2026-04-10' })] },
    });

    const res = await handler(
      makeEvent({
        accountId: 'acc-1',
        startDate: '2026-04-01',
        endDate: '2026-04-30',
        clientHashes: { '2026-04-06': 'client-hash' }, // client has 04-06, server has 04-10
      }),
      {} as any, () => {},
    ) as any;

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.data.staleDays).toContain('2026-04-10');
  });

  // 9. Day in client not in server -> stale
  it('marks day in client but not in server as stale', async () => {
    // Chain: 1st = DailyStats query (empty), 2nd = fetchTradesForDays GSI (empty)
    ddbMock.on(QueryCommand)
      .resolvesOnce({ Items: [] })
      .resolvesOnce({ Items: [] });

    const res = await handler(
      makeEvent({
        accountId: 'acc-1',
        startDate: '2026-04-01',
        endDate: '2026-04-30',
        clientHashes: { '2026-04-06': 'orphan-hash' },
      }),
      {} as any, () => {},
    ) as any;

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.data.staleDays).toContain('2026-04-06');
    // No trades returned since server has nothing
    expect(body.data.trades).toEqual([]);
  });

  // 10. accountId='ALL' combines hashes per day (SHA-256 of sorted accountId:hash pairs)
  it('combines hashes per day with SHA-256 when accountId is ALL', async () => {
    const { createHash } = await import('crypto');
    const rec1 = makeDailyRecord({ accountId: 'acc-1', date: '2026-04-06', sk: 'acc-1#2026-04-06', tradeHash: 'hash-a' });
    const rec2 = makeDailyRecord({ accountId: 'acc-2', date: '2026-04-06', sk: 'acc-2#2026-04-06', tradeHash: 'hash-b' });
    ddbMock.on(QueryCommand).resolvesOnce({ Items: [rec1, rec2] });

    // No stale days if client matches combined hash
    const sorted = ['acc-1:hash-a', 'acc-2:hash-b']; // already sorted
    const expectedHash = createHash('sha256').update(sorted.join('||')).digest('hex');

    const res = await handler(
      makeEvent({
        accountId: 'ALL',
        startDate: '2026-04-01',
        endDate: '2026-04-30',
        clientHashes: { '2026-04-06': expectedHash },
      }),
      {} as any, () => {},
    ) as any;

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.data.serverHashes['2026-04-06']).toBe(expectedHash);
    expect(body.data.staleDays).toEqual([]);
    expect(body.data.trades).toEqual([]);
  });

  // 11. Specific accountId returns only that account's hash (not combined)
  it('returns raw tradeHash for specific accountId (not combined)', async () => {
    const record = makeDailyRecord({ accountId: 'acc-1', date: '2026-04-06', tradeHash: 'raw-hash-123' });
    ddbMock.on(QueryCommand).resolves({ Items: [record] });

    const res = await handler(
      makeEvent({
        accountId: 'acc-1',
        startDate: '2026-04-01',
        endDate: '2026-04-30',
        clientHashes: { '2026-04-06': 'raw-hash-123' },
      }),
      {} as any, () => {},
    ) as any;

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    // For single account, the hash is the raw tradeHash, not a SHA-256 combination
    expect(body.data.serverHashes['2026-04-06']).toBe('raw-hash-123');
    expect(body.data.staleDays).toEqual([]);
  });

  // 12. ServerHashes use YYYY-MM-DD keys (not accountId#date)
  it('uses YYYY-MM-DD keys in serverHashes (not accountId#date)', async () => {
    const record = makeDailyRecord({ date: '2026-04-06', sk: 'acc-1#2026-04-06', tradeHash: 'some-hash' });

    // Chain: 1st = DailyStats, 2nd = fetchTradesForDays GSI
    ddbMock.on(QueryCommand)
      .resolvesOnce({ Items: [record] })
      .resolvesOnce({ Items: [{ userId: 'test-user-id', tradeId: 't1', openDate: '2026-04-06' }] });

    ddbMock.on(BatchGetCommand).resolves({
      Responses: { 'test-trades': [makeTrade()] },
    });

    const res = await handler(
      makeEvent({
        accountId: 'acc-1',
        startDate: '2026-04-01',
        endDate: '2026-04-30',
        clientHashes: {},
      }),
      {} as any, () => {},
    ) as any;

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    const keys = Object.keys(body.data.serverHashes);
    // All keys should be YYYY-MM-DD format, not containing '#'
    for (const key of keys) {
      expect(key).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(key).not.toContain('#');
    }
  });

  // 13. fetchTradesForDays uses GSI + BatchGet pattern
  it('uses trades-by-date-gsi and BatchGetCommand to fetch trades', async () => {
    const record = makeDailyRecord({ date: '2026-04-06', tradeHash: 'stale-hash' });

    // Chain: 1st = DailyStats, 2nd = fetchTradesForDays GSI
    ddbMock.on(QueryCommand)
      .resolvesOnce({ Items: [record] })
      .resolvesOnce({ Items: [
        { userId: 'test-user-id', tradeId: 't1', openDate: '2026-04-06' },
        { userId: 'test-user-id', tradeId: 't2', openDate: '2026-04-06' },
      ] });

    const trades = [
      makeTrade({ tradeId: 't1' }),
      makeTrade({ tradeId: 't2' }),
    ];
    ddbMock.on(BatchGetCommand).resolves({ Responses: { 'test-trades': trades } });

    const res = await handler(
      makeEvent({
        accountId: 'acc-1',
        startDate: '2026-04-01',
        endDate: '2026-04-30',
        clientHashes: {},
      }),
      {} as any, () => {},
    ) as any;

    expect(res.statusCode).toBe(200);

    // Verify the GSI query was used (second QueryCommand call is for trades-by-date-gsi)
    const queryCalls = ddbMock.commandCalls(QueryCommand);
    const tradeGsiCall = queryCalls.find(
      call => call.args[0].input.IndexName === 'trades-by-date-gsi',
    );
    expect(tradeGsiCall).toBeDefined();
    expect(tradeGsiCall!.args[0].input.TableName).toBe('test-trades');

    // Verify BatchGetCommand was used
    const batchCalls = ddbMock.commandCalls(BatchGetCommand);
    expect(batchCalls.length).toBeGreaterThanOrEqual(1);
    expect(batchCalls[0].args[0].input.RequestItems!['test-trades']).toBeDefined();
  });

  // 14. Filters trades by accountId when specific
  it('filters trades by accountId when a specific account is given', async () => {
    const record = makeDailyRecord({ date: '2026-04-06', tradeHash: 'stale' });

    // Chain: 1st = DailyStats, 2nd = fetchTradesForDays GSI
    ddbMock.on(QueryCommand)
      .resolvesOnce({ Items: [record] })
      .resolvesOnce({ Items: [
        { userId: 'test-user-id', tradeId: 't1', openDate: '2026-04-06' },
        { userId: 'test-user-id', tradeId: 't2', openDate: '2026-04-06' },
      ] });

    // BatchGet returns trades from different accounts
    const trade1 = makeTrade({ tradeId: 't1', accountId: 'acc-1' });
    const trade2 = makeTrade({ tradeId: 't2', accountId: 'acc-2' }); // different account
    ddbMock.on(BatchGetCommand).resolves({ Responses: { 'test-trades': [trade1, trade2] } });

    const res = await handler(
      makeEvent({
        accountId: 'acc-1',
        startDate: '2026-04-01',
        endDate: '2026-04-30',
        clientHashes: {},
      }),
      {} as any, () => {},
    ) as any;

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    // Only acc-1 trades should be returned
    expect(body.data.trades).toHaveLength(1);
    expect(body.data.trades[0].accountId).toBe('acc-1');
  });

  // 15. No filter when accountId='ALL'
  it('does not filter trades by accountId when ALL is specified', async () => {
    const rec1 = makeDailyRecord({ accountId: 'acc-1', date: '2026-04-06', sk: 'acc-1#2026-04-06', tradeHash: 'h1' });
    const rec2 = makeDailyRecord({ accountId: 'acc-2', date: '2026-04-06', sk: 'acc-2#2026-04-06', tradeHash: 'h2' });

    // Chain: 1st = DailyStats (ALL uses GSI), 2nd = fetchTradesForDays GSI
    ddbMock.on(QueryCommand)
      .resolvesOnce({ Items: [rec1, rec2] })
      .resolvesOnce({ Items: [
        { userId: 'test-user-id', tradeId: 't1', openDate: '2026-04-06' },
        { userId: 'test-user-id', tradeId: 't2', openDate: '2026-04-06' },
      ] });

    const trade1 = makeTrade({ tradeId: 't1', accountId: 'acc-1' });
    const trade2 = makeTrade({ tradeId: 't2', accountId: 'acc-2' });
    ddbMock.on(BatchGetCommand).resolves({ Responses: { 'test-trades': [trade1, trade2] } });

    const res = await handler(
      makeEvent({
        accountId: 'ALL',
        startDate: '2026-04-01',
        endDate: '2026-04-30',
        clientHashes: {}, // empty so all days are stale
      }),
      {} as any, () => {},
    ) as any;

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    // Both accounts' trades should be returned (no filtering)
    expect(body.data.trades).toHaveLength(2);
    const accountIds = body.data.trades.map((t: any) => t.accountId).sort();
    expect(accountIds).toEqual(['acc-1', 'acc-2']);
  });
});
