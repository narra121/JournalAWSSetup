import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBDocumentClient, QueryCommand } from '@aws-sdk/lib-dynamodb';

// Stub env before importing handler
vi.stubEnv('DAILY_STATS_TABLE', 'test-daily-stats');

// Mock DynamoDBDocumentClient
const ddbMock = mockClient(DynamoDBDocumentClient);

const { handler } = await import('../app.ts');

// --- Helpers ----------------------------------------------------------------

function makeJwt(sub: string): string {
  const header = btoa(JSON.stringify({ alg: 'RS256' }));
  const payload = btoa(JSON.stringify({ sub }));
  return `${header}.${payload}.sig`;
}

function makeEvent(body: Record<string, any> = {}, overrides: Record<string, any> = {}): any {
  const jwt = makeJwt('test-user-id');
  return {
    requestContext: { requestId: 'test-req', authorizer: { jwt: { claims: { sub: 'test-user-id' } } } },
    headers: { authorization: `Bearer ${jwt}` },
    body: JSON.stringify(body),
    ...overrides,
  };
}

function makeUnauthEvent(body: Record<string, any> = {}): any {
  return {
    requestContext: { requestId: 'test-req', authorizer: {} },
    headers: {},
    body: JSON.stringify(body),
  };
}

// --- Sample records ----------------------------------------------------------

function makeDailyRecord(sk: string, tradeHash?: string, accountId?: string) {
  const parts = sk.split('#');
  return {
    sk,
    tradeHash,
    accountId: accountId || parts[0],
    date: parts[1],
  };
}

function makeMonthlyRecord(accountId: string, month: string, monthHash: string) {
  return {
    sk: `${accountId}#MONTH#${month}`,
    accountId,
    month,
    monthHash,
  };
}

// --- Tests ------------------------------------------------------------------

beforeEach(() => {
  ddbMock.reset();
});

describe('verify-hashes handler', () => {
  // -- Auth ------------------------------------------------------------------

  it('returns 401 when no auth', async () => {
    const event = makeUnauthEvent({
      accountId: 'acc-1',
      startDate: '2026-04-01',
      endDate: '2026-04-30',
      clientMonthHashes: {},
      clientDayHashes: {},
    });

    const res = await handler(event as any);

    expect(res.statusCode).toBe(401);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(false);
    expect(body.errorCode).toBe('UNAUTHORIZED');
  });

  // -- Validation ------------------------------------------------------------

  it('returns 400 when body is invalid JSON', async () => {
    const event = makeEvent({});
    event.body = 'not-json';

    const res = await handler(event as any);

    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(false);
  });

  it('returns 400 when missing accountId', async () => {
    const res = await handler(makeEvent({
      startDate: '2026-04-01',
      endDate: '2026-04-30',
      clientMonthHashes: {},
      clientDayHashes: {},
    }) as any);

    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(false);
    expect(body.message).toContain('accountId');
  });

  it('returns 400 when missing startDate', async () => {
    const res = await handler(makeEvent({
      accountId: 'acc-1',
      endDate: '2026-04-30',
      clientMonthHashes: {},
      clientDayHashes: {},
    }) as any);

    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(false);
    expect(body.message).toContain('startDate');
  });

  it('returns 400 when missing endDate', async () => {
    const res = await handler(makeEvent({
      accountId: 'acc-1',
      startDate: '2026-04-01',
      clientMonthHashes: {},
      clientDayHashes: {},
    }) as any);

    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(false);
    expect(body.message).toContain('endDate');
  });

  it('returns 400 when clientMonthHashes is missing', async () => {
    const res = await handler(makeEvent({
      accountId: 'acc-1',
      startDate: '2026-04-01',
      endDate: '2026-04-30',
      clientDayHashes: {},
    }) as any);

    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(false);
    expect(body.message).toContain('clientMonthHashes');
  });

  it('returns 400 when clientDayHashes is missing', async () => {
    const res = await handler(makeEvent({
      accountId: 'acc-1',
      startDate: '2026-04-01',
      endDate: '2026-04-30',
      clientMonthHashes: {},
    }) as any);

    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(false);
    expect(body.message).toContain('clientDayHashes');
  });

  // -- All month hashes match ------------------------------------------------

  it('returns batchMatch=true when all month hashes match', async () => {
    // Setup: server has one monthly record and two daily records
    const monthlyRec = makeMonthlyRecord('acc-1', '2026-04', 'month-hash-abc');
    const daily1 = makeDailyRecord('acc-1#2026-04-15', 'day-hash-1');
    const daily2 = makeDailyRecord('acc-1#2026-04-16', 'day-hash-2');

    // First query: daily records
    ddbMock.on(QueryCommand).callsFake((input: any) => {
      if (input.ExpressionAttributeValues?.[':skStart']?.includes('#MONTH#')) {
        // Monthly records query
        return { Items: [monthlyRec] };
      }
      // Daily records query
      return { Items: [daily1, daily2] };
    });

    const res = await handler(makeEvent({
      accountId: 'acc-1',
      startDate: '2026-04-01',
      endDate: '2026-04-30',
      clientMonthHashes: { 'acc-1#2026-04': 'month-hash-abc' },
      clientDayHashes: { 'acc-1#2026-04-15': 'day-hash-1', 'acc-1#2026-04-16': 'day-hash-2' },
    }) as any);

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(true);
    expect(body.data.batchMatch).toBe(true);
    expect(body.data.staleDays).toHaveLength(0);
    expect(Object.keys(body.data.serverMonthHashes)).toHaveLength(0);
    expect(Object.keys(body.data.serverDayHashes)).toHaveLength(0);
  });

  // -- One month hash differs ------------------------------------------------

  it('returns stale days within a month when month hash differs', async () => {
    const monthlyRec = makeMonthlyRecord('acc-1', '2026-04', 'server-month-hash');
    const daily1 = makeDailyRecord('acc-1#2026-04-15', 'day-hash-1');
    const daily2 = makeDailyRecord('acc-1#2026-04-16', 'server-day-hash-2');

    ddbMock.on(QueryCommand).callsFake((input: any) => {
      if (input.ExpressionAttributeValues?.[':skStart']?.includes('#MONTH#')) {
        return { Items: [monthlyRec] };
      }
      return { Items: [daily1, daily2] };
    });

    const res = await handler(makeEvent({
      accountId: 'acc-1',
      startDate: '2026-04-01',
      endDate: '2026-04-30',
      clientMonthHashes: { 'acc-1#2026-04': 'client-month-hash-OLD' },
      clientDayHashes: { 'acc-1#2026-04-15': 'day-hash-1', 'acc-1#2026-04-16': 'client-day-hash-OLD' },
    }) as any);

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.data.batchMatch).toBe(false);
    // day-hash-1 matches, but day-hash-2 differs
    expect(body.data.staleDays).toContain('acc-1#2026-04-16');
    expect(body.data.staleDays).not.toContain('acc-1#2026-04-15');
    // Server hashes for stale month returned
    expect(body.data.serverMonthHashes['acc-1#2026-04']).toBe('server-month-hash');
    expect(body.data.serverDayHashes['acc-1#2026-04-15']).toBe('day-hash-1');
    expect(body.data.serverDayHashes['acc-1#2026-04-16']).toBe('server-day-hash-2');
  });

  // -- Client has extra days server doesn't (deleted trades) -----------------

  it('reports client-only days as stale (deleted trades)', async () => {
    const monthlyRec = makeMonthlyRecord('acc-1', '2026-04', 'server-month-hash');
    // Server only has one daily record
    const daily1 = makeDailyRecord('acc-1#2026-04-15', 'day-hash-1');

    ddbMock.on(QueryCommand).callsFake((input: any) => {
      if (input.ExpressionAttributeValues?.[':skStart']?.includes('#MONTH#')) {
        return { Items: [monthlyRec] };
      }
      return { Items: [daily1] };
    });

    const res = await handler(makeEvent({
      accountId: 'acc-1',
      startDate: '2026-04-01',
      endDate: '2026-04-30',
      clientMonthHashes: { 'acc-1#2026-04': 'client-month-hash-OLD' },
      clientDayHashes: {
        'acc-1#2026-04-15': 'day-hash-1',
        'acc-1#2026-04-20': 'orphan-day-hash',  // client has day server doesn't
      },
    }) as any);

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.data.batchMatch).toBe(false);
    // The orphan day should be stale (server doesn't have it)
    expect(body.data.staleDays).toContain('acc-1#2026-04-20');
    // acc-1#2026-04-15 matches so not stale
    expect(body.data.staleDays).not.toContain('acc-1#2026-04-15');
  });

  // -- Server has days client doesn't (new trades) ---------------------------

  it('reports server-only days as stale (new trades)', async () => {
    const monthlyRec = makeMonthlyRecord('acc-1', '2026-04', 'server-month-hash');
    const daily1 = makeDailyRecord('acc-1#2026-04-15', 'day-hash-1');
    const daily2 = makeDailyRecord('acc-1#2026-04-18', 'new-day-hash');

    ddbMock.on(QueryCommand).callsFake((input: any) => {
      if (input.ExpressionAttributeValues?.[':skStart']?.includes('#MONTH#')) {
        return { Items: [monthlyRec] };
      }
      return { Items: [daily1, daily2] };
    });

    const res = await handler(makeEvent({
      accountId: 'acc-1',
      startDate: '2026-04-01',
      endDate: '2026-04-30',
      clientMonthHashes: { 'acc-1#2026-04': 'client-month-hash-OLD' },
      clientDayHashes: { 'acc-1#2026-04-15': 'day-hash-1' },
    }) as any);

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.data.batchMatch).toBe(false);
    // Server has new day that client doesn't
    expect(body.data.staleDays).toContain('acc-1#2026-04-18');
    expect(body.data.staleDays).not.toContain('acc-1#2026-04-15');
  });

  // -- Empty client hashes ---------------------------------------------------

  it('returns all server days as stale when client sends empty hashes', async () => {
    const monthlyRec = makeMonthlyRecord('acc-1', '2026-04', 'server-month-hash');
    const daily1 = makeDailyRecord('acc-1#2026-04-15', 'day-hash-1');
    const daily2 = makeDailyRecord('acc-1#2026-04-16', 'day-hash-2');

    ddbMock.on(QueryCommand).callsFake((input: any) => {
      if (input.ExpressionAttributeValues?.[':skStart']?.includes('#MONTH#')) {
        return { Items: [monthlyRec] };
      }
      return { Items: [daily1, daily2] };
    });

    const res = await handler(makeEvent({
      accountId: 'acc-1',
      startDate: '2026-04-01',
      endDate: '2026-04-30',
      clientMonthHashes: {},
      clientDayHashes: {},
    }) as any);

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.data.batchMatch).toBe(false);
    // All server days should be stale
    expect(body.data.staleDays).toContain('acc-1#2026-04-15');
    expect(body.data.staleDays).toContain('acc-1#2026-04-16');
    expect(body.data.serverMonthHashes['acc-1#2026-04']).toBe('server-month-hash');
  });

  // -- No server data --------------------------------------------------------

  it('returns batchMatch=true when server has no data and client has no hashes', async () => {
    ddbMock.on(QueryCommand).resolves({ Items: [] });

    const res = await handler(makeEvent({
      accountId: 'acc-1',
      startDate: '2026-04-01',
      endDate: '2026-04-30',
      clientMonthHashes: {},
      clientDayHashes: {},
    }) as any);

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.data.batchMatch).toBe(true);
    expect(body.data.staleDays).toHaveLength(0);
  });

  // -- Client has data but server is empty -----------------------------------

  it('returns stale when client has hashes but server is empty', async () => {
    ddbMock.on(QueryCommand).resolves({ Items: [] });

    const res = await handler(makeEvent({
      accountId: 'acc-1',
      startDate: '2026-04-01',
      endDate: '2026-04-30',
      clientMonthHashes: { 'acc-1#2026-04': 'some-hash' },
      clientDayHashes: { 'acc-1#2026-04-15': 'day-hash' },
    }) as any);

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.data.batchMatch).toBe(false);
    // Client's month doesn't exist on server -> stale month
    // Client's day in that stale month -> stale day
    expect(body.data.staleDays).toContain('acc-1#2026-04-15');
  });

  // -- Multiple months: one matches, one stale -------------------------------

  it('handles mixed months: one matching, one stale', async () => {
    const monthlyMar = makeMonthlyRecord('acc-1', '2026-03', 'march-hash');
    const monthlyApr = makeMonthlyRecord('acc-1', '2026-04', 'april-hash-NEW');
    const dailyMar = makeDailyRecord('acc-1#2026-03-20', 'mar-day-hash');
    const dailyApr15 = makeDailyRecord('acc-1#2026-04-15', 'apr-day-hash-1');
    const dailyApr16 = makeDailyRecord('acc-1#2026-04-16', 'apr-day-hash-2');

    ddbMock.on(QueryCommand).callsFake((input: any) => {
      if (input.ExpressionAttributeValues?.[':skStart']?.includes('#MONTH#')) {
        return { Items: [monthlyMar, monthlyApr] };
      }
      return { Items: [dailyMar, dailyApr15, dailyApr16] };
    });

    const res = await handler(makeEvent({
      accountId: 'acc-1',
      startDate: '2026-03-01',
      endDate: '2026-04-30',
      clientMonthHashes: {
        'acc-1#2026-03': 'march-hash',       // matches
        'acc-1#2026-04': 'april-hash-OLD',    // stale
      },
      clientDayHashes: {
        'acc-1#2026-03-20': 'mar-day-hash',
        'acc-1#2026-04-15': 'apr-day-hash-1',      // matches
        'acc-1#2026-04-16': 'apr-day-hash-OLD',     // stale
      },
    }) as any);

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.data.batchMatch).toBe(false);
    // March matches entirely -> no March days in staleDays
    expect(body.data.staleDays).not.toContain('acc-1#2026-03-20');
    // April is stale -> only the differing day is stale
    expect(body.data.staleDays).toContain('acc-1#2026-04-16');
    expect(body.data.staleDays).not.toContain('acc-1#2026-04-15');
    // Server hashes only for stale months
    expect(body.data.serverMonthHashes['acc-1#2026-04']).toBe('april-hash-NEW');
    expect(body.data.serverMonthHashes['acc-1#2026-03']).toBeUndefined();
  });

  // -- accountId='ALL' uses GSI ----------------------------------------------

  it('queries via GSI when accountId is ALL', async () => {
    const daily1 = makeDailyRecord('acc-1#2026-04-15', 'hash-1', 'acc-1');
    const daily2 = makeDailyRecord('acc-2#2026-04-15', 'hash-2', 'acc-2');
    const monthly1 = makeMonthlyRecord('acc-1', '2026-04', 'month-hash-1');
    const monthly2 = makeMonthlyRecord('acc-2', '2026-04', 'month-hash-2');

    let gsiQueryMade = false;
    let monthlyQueryCount = 0;

    ddbMock.on(QueryCommand).callsFake((input: any) => {
      if (input.IndexName === 'stats-by-date-gsi') {
        gsiQueryMade = true;
        return { Items: [daily1, daily2] };
      }
      if (input.ExpressionAttributeValues?.[':skStart']?.includes('#MONTH#')) {
        monthlyQueryCount++;
        const accId = input.ExpressionAttributeValues[':skStart'].split('#MONTH#')[0];
        if (accId === 'acc-1') return { Items: [monthly1] };
        if (accId === 'acc-2') return { Items: [monthly2] };
        return { Items: [] };
      }
      return { Items: [] };
    });

    const res = await handler(makeEvent({
      accountId: 'ALL',
      startDate: '2026-04-01',
      endDate: '2026-04-30',
      clientMonthHashes: {
        'acc-1#2026-04': 'month-hash-1',
        'acc-2#2026-04': 'month-hash-2',
      },
      clientDayHashes: {
        'acc-1#2026-04-15': 'hash-1',
        'acc-2#2026-04-15': 'hash-2',
      },
    }) as any);

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.data.batchMatch).toBe(true);
    expect(gsiQueryMade).toBe(true);
    // Should have queried monthly records for each discovered account
    expect(monthlyQueryCount).toBe(2);
  });

  // -- Single account queries main table, not GSI ----------------------------

  it('uses main table (not GSI) for single account queries', async () => {
    ddbMock.on(QueryCommand).resolves({ Items: [] });

    await handler(makeEvent({
      accountId: 'acc-1',
      startDate: '2026-04-01',
      endDate: '2026-04-30',
      clientMonthHashes: {},
      clientDayHashes: {},
    }) as any);

    const queryCalls = ddbMock.commandCalls(QueryCommand);
    // Should be 2 queries: daily + monthly
    expect(queryCalls.length).toBe(2);
    // Neither should use IndexName
    for (const call of queryCalls) {
      expect(call.args[0].input.IndexName).toBeUndefined();
    }
  });

  // -- DynamoDB error ---------------------------------------------------------

  it('returns 500 when DynamoDB query fails', async () => {
    ddbMock.on(QueryCommand).rejects(new Error('DynamoDB timeout'));

    const res = await handler(makeEvent({
      accountId: 'acc-1',
      startDate: '2026-04-01',
      endDate: '2026-04-30',
      clientMonthHashes: {},
      clientDayHashes: {},
    }) as any);

    expect(res.statusCode).toBe(500);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(false);
    expect(body.errorCode).toBe('INTERNAL_ERROR');
  });

  // -- Pagination handling ---------------------------------------------------

  it('handles pagination for daily records', async () => {
    const daily1 = makeDailyRecord('acc-1#2026-04-15', 'hash-1');
    const daily2 = makeDailyRecord('acc-1#2026-04-16', 'hash-2');

    let callCount = 0;
    ddbMock.on(QueryCommand).callsFake((input: any) => {
      if (input.ExpressionAttributeValues?.[':skStart']?.includes('#MONTH#')) {
        return { Items: [] };
      }
      callCount++;
      if (callCount === 1) {
        return {
          Items: [daily1],
          LastEvaluatedKey: { userId: 'test-user-id', sk: 'acc-1#2026-04-15' },
        };
      }
      return { Items: [daily2] };
    });

    const res = await handler(makeEvent({
      accountId: 'acc-1',
      startDate: '2026-04-01',
      endDate: '2026-04-30',
      clientMonthHashes: {},
      clientDayHashes: {},
    }) as any);

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    // Both days should be in staleDays since client hashes are empty
    expect(body.data.staleDays).toContain('acc-1#2026-04-15');
    expect(body.data.staleDays).toContain('acc-1#2026-04-16');
  });

  // -- Daily records without tradeHash are excluded from hashes ---------------

  it('ignores daily records without tradeHash', async () => {
    const dailyWithHash = makeDailyRecord('acc-1#2026-04-15', 'hash-1');
    const dailyWithout = { sk: 'acc-1#2026-04-16', accountId: 'acc-1', date: '2026-04-16' };

    ddbMock.on(QueryCommand).callsFake((input: any) => {
      if (input.ExpressionAttributeValues?.[':skStart']?.includes('#MONTH#')) {
        return { Items: [] };
      }
      return { Items: [dailyWithHash, dailyWithout] };
    });

    const res = await handler(makeEvent({
      accountId: 'acc-1',
      startDate: '2026-04-01',
      endDate: '2026-04-30',
      clientMonthHashes: {},
      clientDayHashes: { 'acc-1#2026-04-15': 'hash-1' },
    }) as any);

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    // day with hash matches, day without hash is not in server day hashes
    // so it won't appear in staleDays since it's not in either set
    expect(body.data.staleDays).not.toContain('acc-1#2026-04-16');
  });

  // -- staleDays are sorted ---------------------------------------------------

  it('returns staleDays in sorted order', async () => {
    const daily1 = makeDailyRecord('acc-1#2026-04-20', 'hash-20');
    const daily2 = makeDailyRecord('acc-1#2026-04-05', 'hash-05');
    const daily3 = makeDailyRecord('acc-1#2026-04-12', 'hash-12');

    ddbMock.on(QueryCommand).callsFake((input: any) => {
      if (input.ExpressionAttributeValues?.[':skStart']?.includes('#MONTH#')) {
        return { Items: [] };
      }
      return { Items: [daily1, daily2, daily3] };
    });

    const res = await handler(makeEvent({
      accountId: 'acc-1',
      startDate: '2026-04-01',
      endDate: '2026-04-30',
      clientMonthHashes: {},
      clientDayHashes: {},
    }) as any);

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.data.staleDays).toEqual([
      'acc-1#2026-04-05',
      'acc-1#2026-04-12',
      'acc-1#2026-04-20',
    ]);
  });

  // -- ProjectionExpression used for efficiency --------------------------------

  it('uses ProjectionExpression to minimize data transfer', async () => {
    ddbMock.on(QueryCommand).resolves({ Items: [] });

    await handler(makeEvent({
      accountId: 'acc-1',
      startDate: '2026-04-01',
      endDate: '2026-04-30',
      clientMonthHashes: {},
      clientDayHashes: {},
    }) as any);

    const queryCalls = ddbMock.commandCalls(QueryCommand);
    for (const call of queryCalls) {
      expect(call.args[0].input.ProjectionExpression).toBeDefined();
    }
  });

  // -- Month derivation from dates -------------------------------------------

  it('derives correct month range from date range spanning multiple months', async () => {
    ddbMock.on(QueryCommand).resolves({ Items: [] });

    await handler(makeEvent({
      accountId: 'acc-1',
      startDate: '2026-01-15',
      endDate: '2026-03-20',
      clientMonthHashes: {},
      clientDayHashes: {},
    }) as any);

    const queryCalls = ddbMock.commandCalls(QueryCommand);
    // Find the monthly query
    const monthlyQuery = queryCalls.find(c =>
      c.args[0].input.ExpressionAttributeValues?.[':skStart']?.includes('#MONTH#')
    );
    expect(monthlyQuery).toBeDefined();
    expect(monthlyQuery!.args[0].input.ExpressionAttributeValues![':skStart']).toBe('acc-1#MONTH#2026-01');
    expect(monthlyQuery!.args[0].input.ExpressionAttributeValues![':skEnd']).toBe('acc-1#MONTH#2026-03');
  });

  // -- ALL accounts with no daily records returns batchMatch=true -------------

  it('returns batchMatch=true for ALL accounts when no data exists', async () => {
    ddbMock.on(QueryCommand).resolves({ Items: [] });

    const res = await handler(makeEvent({
      accountId: 'ALL',
      startDate: '2026-04-01',
      endDate: '2026-04-30',
      clientMonthHashes: {},
      clientDayHashes: {},
    }) as any);

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.data.batchMatch).toBe(true);
    expect(body.data.staleDays).toHaveLength(0);
  });
});
