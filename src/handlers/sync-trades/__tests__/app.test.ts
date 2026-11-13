import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBDocumentClient, QueryCommand, BatchGetCommand, GetCommand } from '@aws-sdk/lib-dynamodb';

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
    expect(Object.keys(body.data.tradesByDay)).toEqual(['2026-04-06', '2026-04-07']);
    expect(body.data.tradesByDay['2026-04-06'].map((t: any) => t.tradeId)).toEqual(['t1']);
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
    expect(body.data.tradesByDay).toEqual({});
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
    expect(body.data.tradesByDay['2026-04-07']).toHaveLength(1);
    expect(body.data.tradesByDay['2026-04-07'][0].tradeId).toBe('t2');
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
    // The day is stale but holds no trades: it is returned as an empty day so the client clears its cache
    expect(body.data.tradesByDay).toEqual({ '2026-04-06': [] });
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
    expect(body.data.tradesByDay).toEqual({});
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
    expect(body.data.tradesByDay['2026-04-06']).toHaveLength(1);
    expect(body.data.tradesByDay['2026-04-06'][0].accountId).toBe('acc-1');
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
    expect(body.data.tradesByDay['2026-04-06']).toHaveLength(2);
    const accountIds = body.data.tradesByDay['2026-04-06'].map((t: any) => t.accountId).sort();
    expect(accountIds).toEqual(['acc-1', 'acc-2']);
  });

  // ── Local days (BE-006 / X-001) ──────────────────────────────

  describe("trades are grouped by the user's local day", () => {
    it('a trade at 20:00Z on 04-10 (04-11 in Kolkata) is returned under 04-11, found by the exact UTC range of that local day', async () => {
      vi.stubEnv('USER_PREFERENCES_TABLE', 'test-prefs');
      ddbMock.on(GetCommand, { TableName: 'test-prefs' }).resolves({ Item: { timeZone: 'Asia/Kolkata' } });
      const record = makeDailyRecord({ date: '2026-04-11', sk: 'acc-1#2026-04-11', tradeHash: 'h-0411' });
      const late = makeTrade({ tradeId: 'late', openDate: '2026-04-10T20:00:00.000Z' });
      ddbMock.on(QueryCommand, { TableName: 'test-daily-stats' }).resolves({ Items: [record] });
      ddbMock.on(QueryCommand, { IndexName: 'trades-by-date-gsi' }).resolves({ Items: [{ userId: 'test-user-id', tradeId: 'late' }] });
      ddbMock.on(BatchGetCommand).resolves({ Responses: { 'test-trades': [late] } });

      const res = await handler(makeEvent({ accountId: 'acc-1', startDate: '2026-04-01', endDate: '2026-04-30', clientHashes: {} }), {} as any, () => {}) as any;
      const body = JSON.parse(res.body);

      expect(body.data.staleDays).toEqual(['2026-04-11']);
      expect(body.data.tradesByDay).toEqual({ '2026-04-11': [late] });
      const gsi = ddbMock.commandCalls(QueryCommand).find((c) => c.args[0].input.IndexName === 'trades-by-date-gsi')!.args[0].input;
      expect(gsi.ExpressionAttributeValues).toMatchObject({ ':start': '2026-04-10T18:30:00.000Z', ':end': '2026-04-11T18:29:59.999Z' });
    });

    it('drops neighbouring-day trades that the index range also returns (date-only values west of UTC)', async () => {
      vi.stubEnv('USER_PREFERENCES_TABLE', 'test-prefs');
      ddbMock.on(GetCommand, { TableName: 'test-prefs' }).resolves({ Item: { timeZone: 'America/New_York' } });
      const record = makeDailyRecord({ date: '2026-04-10', sk: 'acc-1#2026-04-10', tradeHash: 'h' });
      const earlyUtc = makeTrade({ tradeId: 'prev-day', openDate: '2026-04-10T02:00:00.000Z' }); // 04-09 22:00 in New York
      const dateOnly = makeTrade({ tradeId: 'date-only', openDate: '2026-04-10' });
      const inDay = makeTrade({ tradeId: 'in-day', openDate: '2026-04-10T15:00:00.000Z' });
      ddbMock.on(QueryCommand, { TableName: 'test-daily-stats' }).resolves({ Items: [record] });
      ddbMock.on(QueryCommand, { IndexName: 'trades-by-date-gsi' }).resolves({ Items: [earlyUtc, dateOnly, inDay].map((x) => ({ userId: 'test-user-id', tradeId: x.tradeId })) });
      ddbMock.on(BatchGetCommand).resolves({ Responses: { 'test-trades': [earlyUtc, dateOnly, inDay] } });

      const res = await handler(makeEvent({ accountId: 'acc-1', startDate: '2026-04-01', endDate: '2026-04-30', clientHashes: {} }), {} as any, () => {}) as any;
      const ids = JSON.parse(res.body).data.tradesByDay['2026-04-10'].map((t: any) => t.tradeId).sort();

      expect(ids).toEqual(['date-only', 'in-day']);
      const gsi = ddbMock.commandCalls(QueryCommand).find((c) => c.args[0].input.IndexName === 'trades-by-date-gsi')!.args[0].input;
      expect(gsi.ExpressionAttributeValues).toMatchObject({ ':start': '2026-04-10' });
    });
  });

  // ── Incomplete days (BE-040) ─────────────────────────────────

  describe('days that could not be loaded completely', () => {
    it('retries unprocessed keys and returns the trade', async () => {
      const record = makeDailyRecord({ date: '2026-04-06', tradeHash: 'h' });
      ddbMock.on(QueryCommand, { TableName: 'test-daily-stats' }).resolves({ Items: [record] });
      ddbMock.on(QueryCommand, { IndexName: 'trades-by-date-gsi' }).resolves({ Items: [{ userId: 'test-user-id', tradeId: 't1' }, { userId: 'test-user-id', tradeId: 't2' }] });
      ddbMock.on(BatchGetCommand)
        .resolvesOnce({ Responses: { 'test-trades': [makeTrade({ tradeId: 't1' })] }, UnprocessedKeys: { 'test-trades': { Keys: [{ userId: 'test-user-id', tradeId: 't2' }] } } })
        .resolvesOnce({ Responses: { 'test-trades': [makeTrade({ tradeId: 't2' })] } });

      const res = await handler(makeEvent({ accountId: 'acc-1', startDate: '2026-04-01', endDate: '2026-04-30', clientHashes: {} }), {} as any, () => {}) as any;
      const body = JSON.parse(res.body);

      expect(body.data.tradesByDay['2026-04-06'].map((t: any) => t.tradeId).sort()).toEqual(['t1', 't2']);
      expect(body.data.serverHashes['2026-04-06']).toBe('h');
    });

    it('a day whose keys stay unprocessed is left out of tradesByDay and its server hash is withheld', async () => {
      const ok = makeDailyRecord({ date: '2026-04-06', sk: 'acc-1#2026-04-06', tradeHash: 'h6' });
      const bad = makeDailyRecord({ date: '2026-04-07', sk: 'acc-1#2026-04-07', tradeHash: 'h7' });
      ddbMock.on(QueryCommand, { TableName: 'test-daily-stats' }).resolves({ Items: [ok, bad] });
      ddbMock.on(QueryCommand, { IndexName: 'trades-by-date-gsi' }).callsFake((input: any) => ({
        Items: [{ userId: 'test-user-id', tradeId: input.ExpressionAttributeValues[':start'] === '2026-04-06' ? 't6' : 't7' }],
      }));
      ddbMock.on(BatchGetCommand).callsFake((input: any) => {
        const keys = input.RequestItems['test-trades'].Keys;
        return keys[0].tradeId === 't6'
          ? { Responses: { 'test-trades': [makeTrade({ tradeId: 't6', openDate: '2026-04-06' })] } }
          : { Responses: { 'test-trades': [] }, UnprocessedKeys: { 'test-trades': { Keys: keys } } };
      });
      vi.useFakeTimers();
      const pending = handler(makeEvent({ accountId: 'acc-1', startDate: '2026-04-01', endDate: '2026-04-30', clientHashes: {} }), {} as any, () => {}) as Promise<any>;
      await vi.runAllTimersAsync();
      const res = await pending;
      vi.useRealTimers();
      const body = JSON.parse(res.body);

      expect(res.statusCode).toBe(200);
      expect(body.data.staleDays).toEqual(['2026-04-06', '2026-04-07']);
      expect(Object.keys(body.data.tradesByDay)).toEqual(['2026-04-06']);
      expect(body.data.serverHashes).toEqual({ '2026-04-06': 'h6' });
    });

    it('queries at most 4 stale days at a time', async () => {
      const days = Array.from({ length: 10 }, (_, i) => `2026-04-${String(i + 1).padStart(2, '0')}`);
      ddbMock.on(QueryCommand, { TableName: 'test-daily-stats' }).resolves({ Items: days.map((d) => makeDailyRecord({ date: d, sk: `acc-1#${d}`, tradeHash: d })) });
      let running = 0; let peak = 0;
      ddbMock.on(QueryCommand, { IndexName: 'trades-by-date-gsi' }).callsFake(async () => {
        running++; peak = Math.max(peak, running);
        await new Promise((r) => setTimeout(r, 5));
        running--;
        return { Items: [] };
      });
      const res = await handler(makeEvent({ accountId: 'acc-1', startDate: '2026-04-01', endDate: '2026-04-30', clientHashes: {} }), {} as any, () => {}) as any;
      expect(JSON.parse(res.body).data.staleDays).toHaveLength(10);
      expect(peak).toBeLessThanOrEqual(4);
    });
  });

  it('400 for a start or end date that is not a real day', async () => {
    for (const range of [{ startDate: 'x', endDate: '2026-04-30' }, { startDate: '2026-04-01', endDate: '2026-13-30' }]) {
      const res = await handler(makeEvent({ accountId: 'acc-1', ...range, clientHashes: {} }), {} as any, () => {}) as any;
      expect(res.statusCode).toBe(400);
    }
  });

  it('ignores client hash keys that are not calendar days', async () => {
    ddbMock.on(QueryCommand).resolves({ Items: [] });
    const res = await handler(makeEvent({ accountId: 'acc-1', startDate: '2026-04-01', endDate: '2026-04-30', clientHashes: { '2026-04-05x': 'a', '2026-04-31': 'b' } }), {} as any, () => {}) as any;
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).data.staleDays).toEqual([]);
  });
});
