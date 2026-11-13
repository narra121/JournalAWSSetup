import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import {
  DynamoDBDocumentClient,
  QueryCommand,
  PutCommand,
  DeleteCommand,
  GetCommand,
  UpdateCommand,
  BatchGetCommand,
} from '@aws-sdk/lib-dynamodb';
import { marshall } from '@aws-sdk/util-dynamodb';

// Stub env before importing handler
vi.stubEnv('TRADES_TABLE', 'test-trades');
vi.stubEnv('TRADE_STATS_TABLE', 'test-stats');
vi.stubEnv('DAILY_STATS_TABLE', 'test-daily-stats');
vi.stubEnv('ACCOUNTS_TABLE', 'test-accounts');
vi.stubEnv('SAVED_OPTIONS_TABLE', 'test-saved-options');
vi.stubEnv('USER_PREFERENCES_TABLE', 'test-prefs');

// Mock DynamoDBDocumentClient (the shared ddb module instantiates at import time)
const ddbMock = mockClient(DynamoDBDocumentClient);

const { handler } = await import('../app.ts');

// --- Helpers ----------------------------------------------------------------

function makeStreamEvent(records: any[]): any {
  return { Records: records };
}

function makeStreamRecord(
  eventName: 'INSERT' | 'MODIFY' | 'REMOVE',
  newImage?: Record<string, any>,
  oldImage?: Record<string, any>,
  eventID?: string,
) {
  return {
    eventID: eventID || `event-${Math.random().toString(36).slice(2)}`,
    eventName,
    dynamodb: {
      SequenceNumber: eventID || undefined,
      NewImage: newImage ? marshall(newImage) : undefined,
      OldImage: oldImage ? marshall(oldImage) : undefined,
    },
  };
}

function makeTrade(overrides: Record<string, any> = {}) {
  return {
    userId: 'user-1',
    tradeId: 'trade-1',
    symbol: 'AAPL',
    side: 'BUY',
    entryPrice: 100,
    exitPrice: 110,
    quantity: 10,
    openDate: '2026-04-06T09:30:00Z',
    accountId: 'acc-1',
    ...overrides,
  };
}

// --- Tests ------------------------------------------------------------------

beforeEach(() => {
  ddbMock.reset();
  // Default mocks for the dual-write rebuildStats path
  ddbMock.on(GetCommand).resolves({ Item: { initialBalance: 10000 } });
  ddbMock.on(UpdateCommand).resolves({});
  ddbMock.on(PutCommand).resolves({});
  ddbMock.on(DeleteCommand).resolves({});
});

describe('update-stats stream handler', () => {
  // -- INSERT event ----------------------------------------------------------

  it('creates daily stats record for a new trade (INSERT)', async () => {
    const trade = makeTrade();

    // QueryCommand for trades-by-date-gsi (queryTradesForDay) returns the trade
    // QueryCommand for rebuildStats returns the same trade
    ddbMock.on(QueryCommand).resolves({
      Items: [trade],
      LastEvaluatedKey: undefined,
    });
    ddbMock.on(BatchGetCommand).resolves({
      Responses: { 'test-trades': [trade] },
    });

    const event = makeStreamEvent([
      makeStreamRecord('INSERT', trade, undefined, 'evt-insert-1'),
    ]);

    await handler(event, {} as any, () => {});

    // Verify PutCommand was called with DailyStatsTable
    const putCalls = ddbMock.commandCalls(PutCommand);
    expect(putCalls.length).toBeGreaterThanOrEqual(1);

    // Find the PutCommand targeting the daily stats table
    const dailyStatsPut = putCalls.find(
      (c) => c.args[0].input.TableName === 'test-daily-stats',
    );
    expect(dailyStatsPut).toBeDefined();
    const item = dailyStatsPut!.args[0].input.Item;
    expect(item!.userId).toBe('user-1');
    expect(item!.accountId).toBe('acc-1');
    expect(item!.date).toBe('2026-04-06');
    expect(item!.sk).toBe('acc-1#2026-04-06');
  });

  // -- REMOVE event ----------------------------------------------------------

  it('deletes daily record when no more trades on that day (REMOVE)', async () => {
    const trade = makeTrade();

    // queryTradesForDay returns empty (the trade was deleted)
    // rebuildStats also queries trades
    ddbMock
      .on(QueryCommand)
      .resolvesOnce({ Items: [], LastEvaluatedKey: undefined }) // queryTradesForDay
      .resolves({ Items: [], LastEvaluatedKey: undefined });     // rebuildStats

    const event = makeStreamEvent([
      makeStreamRecord('REMOVE', undefined, trade, 'evt-remove-1'),
    ]);

    await handler(event, {} as any, () => {});

    // Verify DeleteCommand was called on DailyStatsTable
    const deleteCalls = ddbMock.commandCalls(DeleteCommand);
    expect(deleteCalls.length).toBeGreaterThanOrEqual(1);

    const dailyStatsDelete = deleteCalls.find(
      (c) => c.args[0].input.TableName === 'test-daily-stats',
    );
    expect(dailyStatsDelete).toBeDefined();
    expect(dailyStatsDelete!.args[0].input.Key).toEqual({
      userId: 'user-1',
      sk: 'acc-1#2026-04-06',
    });
  });

  // -- MODIFY with date change -----------------------------------------------

  it('rebuilds both old and new day when trade date changes (MODIFY)', async () => {
    const oldTrade = makeTrade({ openDate: '2026-04-06T09:30:00Z' });
    const newTrade = makeTrade({ openDate: '2026-04-08T10:00:00Z' });

    // queryTradesForDay will be called for both dates, plus rebuildStats queries
    ddbMock.on(QueryCommand).resolves({
      Items: [newTrade],
      LastEvaluatedKey: undefined,
    });
    ddbMock.on(BatchGetCommand).resolves({
      Responses: { 'test-trades': [newTrade] },
    });

    const event = makeStreamEvent([
      makeStreamRecord('MODIFY', newTrade, oldTrade, 'evt-modify-1'),
    ]);

    await handler(event, {} as any, () => {});

    // Should have queried for both the old date (2026-04-06) and new date (2026-04-08)
    const queryCalls = ddbMock.commandCalls(QueryCommand);

    // Extract the dates queried from the GSI queries (filter for queryTradesForDay calls)
    const gsiQueries = queryCalls.filter(
      (c) => c.args[0].input.IndexName === 'trades-by-date-gsi',
    );
    expect(gsiQueries.length).toBeGreaterThanOrEqual(2);

    const queriedDates = gsiQueries.map(
      (c) => c.args[0].input.ExpressionAttributeValues![':start'],
    );
    expect(queriedDates).toContain('2026-04-06');
    expect(queriedDates).toContain('2026-04-08');
  });

  // -- Skips unmapped trades -------------------------------------------------

  it('skips trades with accountId = -1 (no daily stats write)', async () => {
    const unmappedTrade = makeTrade({ accountId: '-1' });

    // rebuildStats still runs for the userId, but queryTradesForDay should NOT be called
    // for the unmapped trade's day
    ddbMock.on(QueryCommand).resolves({
      Items: [],
      LastEvaluatedKey: undefined,
    });

    const event = makeStreamEvent([
      makeStreamRecord('INSERT', unmappedTrade, undefined, 'evt-unmapped'),
    ]);

    await handler(event, {} as any, () => {});

    // Should NOT have any PutCommand targeting daily stats table for this trade
    const putCalls = ddbMock.commandCalls(PutCommand);
    const dailyStatsPuts = putCalls.filter(
      (c) => c.args[0].input.TableName === 'test-daily-stats',
    );
    expect(dailyStatsPuts).toHaveLength(0);

    // Should NOT have any queryTradesForDay calls (GSI queries)
    const gsiQueries = ddbMock
      .commandCalls(QueryCommand)
      .filter((c) => c.args[0].input.IndexName === 'trades-by-date-gsi');
    expect(gsiQueries).toHaveLength(0);
  });

  // -- Deduplicates affected days --------------------------------------------

  it('deduplicates affected days in a batch (same userId, accountId, date)', async () => {
    const trade1 = makeTrade({ tradeId: 'trade-1', openDate: '2026-04-06T09:30:00Z' });
    const trade2 = makeTrade({ tradeId: 'trade-2', openDate: '2026-04-06T10:00:00Z' });

    ddbMock.on(QueryCommand).resolves({
      Items: [trade1, trade2],
      LastEvaluatedKey: undefined,
    });
    ddbMock.on(BatchGetCommand).resolves({
      Responses: { 'test-trades': [trade1, trade2] },
    });

    const event = makeStreamEvent([
      makeStreamRecord('INSERT', trade1, undefined, 'evt-dup-1'),
      makeStreamRecord('INSERT', trade2, undefined, 'evt-dup-2'),
    ]);

    await handler(event, {} as any, () => {});

    // queryTradesForDay should only be called ONCE for 2026-04-06 (deduplication)
    const gsiQueries = ddbMock
      .commandCalls(QueryCommand)
      .filter((c) => c.args[0].input.IndexName === 'trades-by-date-gsi');

    const dateQueries = gsiQueries.filter(
      (c) => c.args[0].input.ExpressionAttributeValues![':start'] === '2026-04-06',
    );
    expect(dateQueries).toHaveLength(1);

    // Only one PutCommand to daily stats for that day
    const dailyStatsPuts = ddbMock
      .commandCalls(PutCommand)
      .filter((c) => c.args[0].input.TableName === 'test-daily-stats');
    expect(dailyStatsPuts).toHaveLength(1);
  });

  // -- Error handling (batchItemFailures) ------------------------------------

  it('returns batchItemFailures on error', async () => {
    ddbMock.on(QueryCommand).rejects(new Error('DynamoDB error'));

    const event = makeStreamEvent([
      makeStreamRecord('INSERT', makeTrade(), undefined, 'evt-fail-1'),
      makeStreamRecord('INSERT', makeTrade({ tradeId: 'trade-2' }), undefined, 'evt-fail-2'),
    ]);

    const result = (await handler(event, {} as any, () => {})) as any;

    expect(result.batchItemFailures).toBeDefined();
    expect(result.batchItemFailures.length).toBe(2);

    const identifiers = result.batchItemFailures.map((f: any) => f.itemIdentifier);
    expect(identifiers).toContain('evt-fail-1');
    expect(identifiers).toContain('evt-fail-2');
  });

  // -- Incremental account balance update (ADD delta) -----------------------

  describe('user time zone (B-105)', () => {
    const late = () => makeTrade({ tradeId: 'late', openDate: '2026-04-06T20:30:00Z', side: 'BUY', entryPrice: 100, exitPrice: 110, quantity: 1 });

    it('with Asia/Kolkata the 20:30Z trade belongs to 2026-04-07 and the day is queried by its exact UTC range', async () => {
      ddbMock.on(GetCommand, { TableName: 'test-prefs' }).resolves({ Item: { timeZone: 'Asia/Kolkata' } });
      const trade = late();
      ddbMock.on(QueryCommand).resolves({ Items: [trade] });
      ddbMock.on(BatchGetCommand).resolves({ Responses: { 'test-trades': [trade] } });
      await handler(makeStreamEvent([makeStreamRecord('INSERT', trade, undefined, 'evt-tz')]), {} as any, () => {});
      const q = ddbMock.commandCalls(QueryCommand).find((c) => c.args[0].input.IndexName === 'trades-by-date-gsi')!.args[0].input;
      expect(q.ExpressionAttributeValues).toMatchObject({ ':start': '2026-04-06T18:30:00.000Z', ':end': '2026-04-07T18:29:59.999Z' });
      const put = ddbMock.commandCalls(PutCommand).find((c) => c.args[0].input.TableName === 'test-daily-stats')!.args[0].input.Item!;
      expect(put).toMatchObject({ date: '2026-04-07', sk: 'acc-1#2026-04-07' });
      expect(put.hourlyBreakdown['2']).toBeDefined(); // 20:30Z = 02:00 IST
    });

    it('without a preference the day stays the UTC date', async () => {
      ddbMock.on(GetCommand, { TableName: 'test-prefs' }).resolves({});
      const trade = late();
      ddbMock.on(QueryCommand).resolves({ Items: [trade] });
      ddbMock.on(BatchGetCommand).resolves({ Responses: { 'test-trades': [trade] } });
      await handler(makeStreamEvent([makeStreamRecord('INSERT', trade, undefined, 'evt-utc')]), {} as any, () => {});
      const put = ddbMock.commandCalls(PutCommand).find((c) => c.args[0].input.TableName === 'test-daily-stats')!.args[0].input.Item!;
      expect(put.date).toBe('2026-04-06');
    });
  });

  describe('soft delete (BE-E1)', () => {
    const trade = () => makeTrade({ side: 'BUY', entryPrice: 100, exitPrice: 120, quantity: 5 }); // pnl +100
    const accountDelta = () => {
      const call = ddbMock.commandCalls(UpdateCommand).find((c) => c.args[0].input.TableName === 'test-accounts');
      return call?.args[0].input.ExpressionAttributeValues![':delta'];
    };
    const run = async (name: 'MODIFY' | 'REMOVE', newImage: any, oldImage: any) => {
      ddbMock.on(QueryCommand).resolves({ Items: [] });
      ddbMock.on(BatchGetCommand).resolves({ Responses: { 'test-trades': [] } });
      await handler(makeStreamEvent([makeStreamRecord(name, newImage, oldImage, 'evt-sd')]), {} as any, () => {});
    };

    it('a trade becoming deleted subtracts its P&L from the account balance', async () => {
      await run('MODIFY', { ...trade(), deletedAt: '2026-11-11T00:00:00Z' }, trade());
      expect(accountDelta()).toBe(-100);
    });

    it('a restored trade adds its P&L back', async () => {
      await run('MODIFY', trade(), { ...trade(), deletedAt: '2026-11-11T00:00:00Z' });
      expect(accountDelta()).toBe(100);
    });

    it('the TTL purge of an already soft-deleted trade does not change the balance', async () => {
      await run('REMOVE', undefined, { ...trade(), deletedAt: '2026-11-11T00:00:00Z' });
      expect(accountDelta()).toBeUndefined();
    });

    it('rebuilds the day from live trades only (a deleted trade is not counted)', async () => {
      const live = { ...trade(), tradeId: 'live' };
      const gone = { ...trade(), tradeId: 'gone', deletedAt: '2026-11-11T00:00:00Z' };
      ddbMock.on(QueryCommand).resolves({ Items: [live, gone] });
      ddbMock.on(BatchGetCommand).resolves({ Responses: { 'test-trades': [live, gone] } });
      await handler(makeStreamEvent([makeStreamRecord('MODIFY', { ...trade(), deletedAt: 'x' }, trade(), 'evt-sd2')]), {} as any, () => {});
      const put = ddbMock.commandCalls(PutCommand).find((c) => c.args[0].input.TableName === 'test-daily-stats');
      expect(put!.args[0].input.Item!.tradeCount).toBe(1);
    });
  });

  it('adjusts account balance with ADD delta on INSERT', async () => {
    const trade = makeTrade({
      side: 'BUY',
      entryPrice: 100,
      exitPrice: 120,
      quantity: 5,
    });

    ddbMock.on(QueryCommand).resolves({
      Items: [trade],
      LastEvaluatedKey: undefined,
    });
    ddbMock.on(BatchGetCommand).resolves({
      Responses: { 'test-trades': [trade] },
    });

    const event = makeStreamEvent([
      makeStreamRecord('INSERT', trade, undefined, 'evt-dual-1'),
    ]);

    await handler(event, {} as any, () => {});

    // Verify UpdateCommand was called on the accounts table with ADD #balance :delta
    const updateCalls = ddbMock.commandCalls(UpdateCommand);
    const accountUpdate = updateCalls.find(
      (c) => c.args[0].input.TableName === 'test-accounts',
    );
    expect(accountUpdate).toBeDefined();
    expect(accountUpdate!.args[0].input.UpdateExpression).toContain('ADD #balance :delta');
    expect(accountUpdate!.args[0].input.ConditionExpression).toBe('attribute_exists(userId)');
  });

  // -- Skips records with no userId ------------------------------------------

  it('skips record when userId is missing from both images', async () => {
    const event = makeStreamEvent([
      {
        eventID: 'evt-no-user',
        eventName: 'INSERT' as const,
        dynamodb: {
          NewImage: marshall({ tradeId: 'trade-1', accountId: 'acc-1', openDate: '2026-04-06' }),
        },
      },
    ]);

    await handler(event, {} as any, () => {});

    // No QueryCommand should have been made (no userId to process)
    const gsiQueries = ddbMock
      .commandCalls(QueryCommand)
      .filter((c) => c.args[0].input.IndexName === 'trades-by-date-gsi');
    expect(gsiQueries).toHaveLength(0);
  });

  // -- Multiple users in same batch ------------------------------------------

  it('processes records for multiple users independently', async () => {
    const trade1 = makeTrade({ userId: 'user-1', tradeId: 'trade-1' });
    const trade2 = makeTrade({ userId: 'user-2', tradeId: 'trade-2', accountId: 'acc-2' });

    ddbMock.on(QueryCommand).resolves({
      Items: [trade1],
      LastEvaluatedKey: undefined,
    });
    ddbMock.on(BatchGetCommand).resolves({
      Responses: { 'test-trades': [trade1] },
    });

    const event = makeStreamEvent([
      makeStreamRecord('INSERT', trade1, undefined, 'evt-multi-1'),
      makeStreamRecord('INSERT', trade2, undefined, 'evt-multi-2'),
    ]);

    await handler(event, {} as any, () => {});

    // Should have queried trades for both users
    const queryCalls = ddbMock.commandCalls(QueryCommand);
    expect(queryCalls.length).toBeGreaterThanOrEqual(2);

    // Should have processed both users (account balance updates attempted via UpdateCommand)
    const updateCalls = ddbMock.commandCalls(UpdateCommand);
    const accountUpdates = updateCalls.filter(
      (c) => c.args[0].input.TableName === 'test-accounts',
    );
    expect(accountUpdates.length).toBeGreaterThanOrEqual(2);
  });

  // -- Stream record with missing dynamodb field ----------------------------

  it('skips record when dynamodb field is undefined', async () => {
    const event = makeStreamEvent([
      {
        eventID: 'evt-no-dynamodb',
        eventName: 'INSERT',
        // dynamodb is missing entirely
      },
    ]);

    const result = (await handler(event, {} as any, () => {})) as any;

    // Should not crash; no failures returned
    expect(result.batchItemFailures).toHaveLength(0);

    // No DynamoDB operations should have been triggered
    const queryCalls = ddbMock.commandCalls(QueryCommand);
    expect(queryCalls).toHaveLength(0);
  });

  // -- Stream record with empty NewImage and OldImage -----------------------

  it('skips record when both NewImage and OldImage are null', async () => {
    const event = makeStreamEvent([
      {
        eventID: 'evt-empty-images',
        eventName: 'MODIFY',
        dynamodb: {
          NewImage: undefined,
          OldImage: undefined,
        },
      },
    ]);

    const result = (await handler(event, {} as any, () => {})) as any;

    expect(result.batchItemFailures).toHaveLength(0);

    // No GSI queries should have been made (no userId to extract)
    const gsiQueries = ddbMock
      .commandCalls(QueryCommand)
      .filter((c) => c.args[0].input.IndexName === 'trades-by-date-gsi');
    expect(gsiQueries).toHaveLength(0);
  });

  // -- QueryCommand fails when fetching trades for day ----------------------

  it('returns batchItemFailures when queryTradesForDay rejects', async () => {
    // All QueryCommands fail — queryTradesForDay will reject
    ddbMock.on(QueryCommand).rejects(new Error('Throttled'));

    const trade = makeTrade();
    const event = makeStreamEvent([
      makeStreamRecord('INSERT', trade, undefined, 'evt-query-fail'),
    ]);

    const result = (await handler(event, {} as any, () => {})) as any;

    expect(result.batchItemFailures).toBeDefined();
    expect(result.batchItemFailures.length).toBeGreaterThanOrEqual(1);
    const identifiers = result.batchItemFailures.map((f: any) => f.itemIdentifier);
    expect(identifiers).toContain('evt-query-fail');
  });

  // -- PutCommand fails when writing daily stats ----------------------------

  it('returns batchItemFailures when PutCommand for daily stats rejects', async () => {
    const trade = makeTrade();

    // QueryCommand succeeds (returns trade for the day)
    ddbMock.on(QueryCommand).resolves({
      Items: [trade],
      LastEvaluatedKey: undefined,
    });
    ddbMock.on(BatchGetCommand).resolves({
      Responses: { 'test-trades': [trade] },
    });

    // PutCommand fails for daily stats table
    ddbMock.on(PutCommand).rejects(new Error('ConditionalCheckFailed'));

    const event = makeStreamEvent([
      makeStreamRecord('INSERT', trade, undefined, 'evt-put-fail'),
    ]);

    const result = (await handler(event, {} as any, () => {})) as any;

    expect(result.batchItemFailures).toBeDefined();
    expect(result.batchItemFailures.length).toBeGreaterThanOrEqual(1);
    const identifiers = result.batchItemFailures.map((f: any) => f.itemIdentifier);
    expect(identifiers).toContain('evt-put-fail');
  });

  // -- DeleteCommand fails when removing empty day stats --------------------

  it('returns batchItemFailures when DeleteCommand for empty day rejects', async () => {
    const trade = makeTrade();

    // queryTradesForDay returns empty (triggers delete path)
    ddbMock.on(QueryCommand).resolves({
      Items: [],
      LastEvaluatedKey: undefined,
    });

    // DeleteCommand fails
    ddbMock.on(DeleteCommand).rejects(new Error('AccessDenied'));

    const event = makeStreamEvent([
      makeStreamRecord('REMOVE', undefined, trade, 'evt-delete-fail'),
    ]);

    const result = (await handler(event, {} as any, () => {})) as any;

    // The error in the try block marks all records as failed
    expect(result.batchItemFailures).toBeDefined();
    expect(result.batchItemFailures.length).toBeGreaterThanOrEqual(1);
    const identifiers = result.batchItemFailures.map((f: any) => f.itemIdentifier);
    expect(identifiers).toContain('evt-delete-fail');
  });

  // -- Trade with invalid/empty openDate ------------------------------------

  it('skips affected day when trade has empty openDate', async () => {
    const trade = makeTrade({ openDate: '' });

    ddbMock.on(QueryCommand).resolves({
      Items: [],
      LastEvaluatedKey: undefined,
    });

    const event = makeStreamEvent([
      makeStreamRecord('INSERT', trade, undefined, 'evt-empty-date'),
    ]);

    const result = (await handler(event, {} as any, () => {})) as any;

    // Should not crash; extractDate('') returns '' which is falsy, so no day is added
    expect(result.batchItemFailures).toHaveLength(0);

    // No GSI queries for queryTradesForDay should have been made
    // (no valid date was extracted, so no affected days)
    const gsiQueries = ddbMock
      .commandCalls(QueryCommand)
      .filter((c) => c.args[0].input.IndexName === 'trades-by-date-gsi');
    expect(gsiQueries).toHaveLength(0);
  });

  // -- GetCommand fails for account balance (initialBalance) ----------------

  it('handles GetCommand failure for account balance without failing entire batch', async () => {
    const trade = makeTrade();

    ddbMock.on(QueryCommand).resolves({
      Items: [trade],
      LastEvaluatedKey: undefined,
    });
    ddbMock.on(BatchGetCommand).resolves({
      Responses: { 'test-trades': [trade] },
    });
    ddbMock.on(PutCommand).resolves({});

    // GetCommand for initial balance fails
    ddbMock.on(GetCommand).rejects(new Error('Account table unavailable'));

    const event = makeStreamEvent([
      makeStreamRecord('INSERT', trade, undefined, 'evt-get-fail'),
    ]);

    const result = (await handler(event, {} as any, () => {})) as any;

    // updateAccountBalances catches errors per-account, so the batch should succeed
    expect(result.batchItemFailures).toHaveLength(0);

    // Daily stats PutCommand should still have been called
    const dailyStatsPuts = ddbMock
      .commandCalls(PutCommand)
      .filter((c) => c.args[0].input.TableName === 'test-daily-stats');
    expect(dailyStatsPuts.length).toBeGreaterThanOrEqual(1);
  });

  // -- Stream event with 100+ records --------------------------------------

  it('processes a large batch of 100+ stream records', async () => {
    const records: any[] = [];
    for (let i = 0; i < 110; i++) {
      const trade = makeTrade({
        tradeId: `trade-${i}`,
        openDate: `2026-04-06T${String(9 + (i % 8)).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}:00Z`,
      });
      records.push(makeStreamRecord('INSERT', trade, undefined, `evt-batch-${i}`));
    }

    ddbMock.on(QueryCommand).resolves({
      Items: [makeTrade()],
      LastEvaluatedKey: undefined,
    });
    ddbMock.on(BatchGetCommand).resolves({
      Responses: { 'test-trades': [makeTrade()] },
    });

    const event = makeStreamEvent(records);

    const result = (await handler(event, {} as any, () => {})) as any;

    // All records should succeed (no failures)
    expect(result.batchItemFailures).toHaveLength(0);

    // Daily stats should have been written (deduplication means 1 write for the single day)
    const dailyStatsPuts = ddbMock
      .commandCalls(PutCommand)
      .filter((c) => c.args[0].input.TableName === 'test-daily-stats');
    expect(dailyStatsPuts.length).toBeGreaterThanOrEqual(1);

    // Incremental balance update should have been applied via UpdateCommand
    const accountUpdates = ddbMock
      .commandCalls(UpdateCommand)
      .filter((c) => c.args[0].input.TableName === 'test-accounts');
    expect(accountUpdates.length).toBeGreaterThanOrEqual(1);
  });

  // -- MODIFY where accountId changed from valid to '-1' --------------------

  it('only rebuilds old day when accountId changes from valid to -1 (MODIFY)', async () => {
    const oldTrade = makeTrade({ accountId: 'acc-1', openDate: '2026-04-06T09:30:00Z' });
    const newTrade = makeTrade({ accountId: '-1', openDate: '2026-04-06T09:30:00Z' });

    // queryTradesForDay returns empty for the old account's day (trade moved away)
    ddbMock.on(QueryCommand).resolves({
      Items: [],
      LastEvaluatedKey: undefined,
    });

    const event = makeStreamEvent([
      makeStreamRecord('MODIFY', newTrade, oldTrade, 'evt-acc-change'),
    ]);

    await handler(event, {} as any, () => {});

    // Should only query for old account (acc-1) day, not for '-1'
    const gsiQueries = ddbMock
      .commandCalls(QueryCommand)
      .filter((c) => c.args[0].input.IndexName === 'trades-by-date-gsi');

    // Only one GSI query should be made (for the old valid account's date)
    // The '-1' account is skipped entirely before queryTradesForDay is called
    expect(gsiQueries).toHaveLength(1);
    expect(gsiQueries[0].args[0].input.ExpressionAttributeValues![':u']).toBe('user-1');
    expect(gsiQueries[0].args[0].input.ExpressionAttributeValues![':start']).toBe('2026-04-06');
  });

  // -- No full table scan (incremental only) --------------------------------

  it('does not issue a full table scan QueryCommand (no rebuildStats)', async () => {
    const trade = makeTrade();

    ddbMock.on(QueryCommand).resolves({
      Items: [trade],
      LastEvaluatedKey: undefined,
    });
    ddbMock.on(BatchGetCommand).resolves({
      Responses: { 'test-trades': [trade] },
    });

    const event = makeStreamEvent([
      makeStreamRecord('INSERT', trade, undefined, 'evt-no-scan'),
    ]);

    await handler(event, {} as any, () => {});

    // All QueryCommands should target the GSI (queryTradesForDay), none should be
    // a full table scan on TRADES_TABLE without an IndexName (old rebuildStats path)
    const nonGsiQueries = ddbMock
      .commandCalls(QueryCommand)
      .filter(
        (c) =>
          c.args[0].input.TableName === 'test-trades' &&
          !c.args[0].input.IndexName,
      );
    expect(nonGsiQueries).toHaveLength(0);
  });

  // -- MODIFY computes correct PnL delta for balance update ----------------

  it('computes PnL delta correctly on MODIFY (newPnl - oldPnl)', async () => {
    const oldTrade = makeTrade({
      side: 'BUY',
      entryPrice: 100,
      exitPrice: 110,
      quantity: 10,
    }); // PnL = (110-100)*10 = 100
    const newTrade = makeTrade({
      side: 'BUY',
      entryPrice: 100,
      exitPrice: 130,
      quantity: 10,
    }); // PnL = (130-100)*10 = 300

    ddbMock.on(QueryCommand).resolves({
      Items: [newTrade],
      LastEvaluatedKey: undefined,
    });
    ddbMock.on(BatchGetCommand).resolves({
      Responses: { 'test-trades': [newTrade] },
    });

    const event = makeStreamEvent([
      makeStreamRecord('MODIFY', newTrade, oldTrade, 'evt-modify-delta'),
    ]);

    await handler(event, {} as any, () => {});

    // Verify the UpdateCommand on accounts table uses the correct delta (300 - 100 = 200)
    const updateCalls = ddbMock.commandCalls(UpdateCommand);
    const accountUpdate = updateCalls.find(
      (c) => c.args[0].input.TableName === 'test-accounts',
    );
    expect(accountUpdate).toBeDefined();
    expect(accountUpdate!.args[0].input.UpdateExpression).toContain('ADD #balance :delta');
    expect(accountUpdate!.args[0].input.ExpressionAttributeValues![':delta']).toBe(200);
  });

  // -- Symbol sync into SavedOptions -----------------------------------------

  describe('saved symbols (BE-098)', () => {
    const optionUpdates = () => ddbMock.commandCalls(UpdateCommand).filter((c) => c.args[0].input.TableName === 'test-saved-options').map((c) => c.args[0].input);
    const stub = (trade: any) => {
      ddbMock.on(QueryCommand).resolves({ Items: [trade], LastEvaluatedKey: undefined });
      ddbMock.on(BatchGetCommand).resolves({ Responses: { 'test-trades': [trade] } });
    };

    it('appends a new symbol with one conditional update (no read-modify-write)', async () => {
      const trade = makeTrade({ symbol: 'TSLA' });
      stub(trade);
      await handler(makeStreamEvent([makeStreamRecord('INSERT', trade, undefined, 'evt-symbol-sync')]), {} as any, () => {});

      const updates = optionUpdates();
      expect(updates).toHaveLength(1);
      expect(updates[0].Key).toEqual({ userId: 'user-1' });
      expect(updates[0].UpdateExpression).toContain('list_append(if_not_exists(#symbols, :empty), :one)');
      expect(updates[0].ConditionExpression).toBe('attribute_not_exists(#symbols) OR (NOT contains(#symbols, :symbol) AND size(#symbols) < :max)');
      expect(updates[0].ExpressionAttributeValues).toMatchObject({ ':one': ['TSLA'], ':symbol': 'TSLA', ':max': 500 });
      expect(ddbMock.commandCalls(GetCommand).filter((c) => c.args[0].input.TableName === 'test-saved-options')).toHaveLength(0);
    });

    it('a symbol that is already saved (or a full list) fails the condition quietly and does not fail the batch', async () => {
      const trade = makeTrade({ symbol: 'AAPL' });
      stub(trade);
      ddbMock.on(UpdateCommand, { TableName: 'test-saved-options' }).rejects(Object.assign(new Error('The conditional request failed'), { name: 'ConditionalCheckFailedException' }));
      const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      const res = (await handler(makeStreamEvent([makeStreamRecord('INSERT', trade, undefined, 'evt-symbol-dup')]), {} as any, () => {})) as any;
      expect(res.batchItemFailures).toEqual([]);
      expect(err).not.toHaveBeenCalledWith(expect.stringContaining('Failed to sync symbol'), expect.anything());
      err.mockRestore();
    });

    it('another failure is logged and still does not fail the batch', async () => {
      const trade = makeTrade({ symbol: 'AAPL' });
      stub(trade);
      ddbMock.on(UpdateCommand, { TableName: 'test-saved-options' }).rejects(new Error('throttled'));
      const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      const res = (await handler(makeStreamEvent([makeStreamRecord('INSERT', trade, undefined, 'evt-symbol-err')]), {} as any, () => {})) as any;
      expect(res.batchItemFailures).toEqual([]);
      expect(err).toHaveBeenCalledWith(expect.stringContaining('Failed to sync symbol for user user-1'), expect.any(Error));
      err.mockRestore();
    });

    it('syncs the symbol of a MODIFY but not of a REMOVE, once per distinct symbol', async () => {
      const oldTrade = makeTrade({ symbol: 'AAPL' });
      const newTrade = makeTrade({ symbol: 'GOOG' });
      const removedTrade = makeTrade({ symbol: 'NFLX' });
      stub(newTrade);
      await handler(makeStreamEvent([
        makeStreamRecord('MODIFY', newTrade, oldTrade, 'evt-modify-sym'),
        makeStreamRecord('MODIFY', newTrade, oldTrade, 'evt-modify-sym-2'),
        makeStreamRecord('REMOVE', undefined, removedTrade, 'evt-remove-sym'),
      ]), {} as any, () => {});
      expect(optionUpdates().map((u) => (u.ExpressionAttributeValues as any)[':symbol'])).toEqual(['GOOG']);
    });
  });

  // -- Reports batch item failure for single tuple failure -------------------

  it('reports batch item failure when processing a single tuple fails', async () => {
    // Two trades on different days; make the QueryCommand for one day fail
    const trade1 = makeTrade({ tradeId: 'trade-1', openDate: '2026-04-06T09:30:00Z', accountId: 'acc-1' });
    const trade2 = makeTrade({ tradeId: 'trade-2', openDate: '2026-04-07T10:00:00Z', accountId: 'acc-1' });

    // The handler processes tuples (userId#accountId -> dates). We need queryTradesForDay
    // to succeed for one date and fail for the other.
    let callCount = 0;
    ddbMock.on(QueryCommand, { IndexName: 'trades-by-date-gsi' })
      .callsFake((input: any) => {
        callCount++;
        const date = input.ExpressionAttributeValues[':start'];
        if (date === '2026-04-06') {
          // Succeed for first date
          return { Items: [{ userId: 'user-1', tradeId: 'trade-1' }] };
        }
        // Fail for second date
        throw new Error('Simulated tuple failure');
      });

    ddbMock.on(BatchGetCommand).resolves({
      Responses: { 'test-trades': [trade1] },
    });

    const event = makeStreamEvent([
      makeStreamRecord('INSERT', trade1, undefined, 'evt-ok'),
      makeStreamRecord('INSERT', trade2, undefined, 'evt-fail'),
    ]);

    const result = (await handler(event, {} as any, () => {})) as any;

    // The failed tuple should produce a batch item failure
    expect(result.batchItemFailures).toBeDefined();
    expect(result.batchItemFailures.length).toBeGreaterThanOrEqual(1);
    const identifiers = result.batchItemFailures.map((f: any) => f.itemIdentifier);
    expect(identifiers).toContain('evt-fail');

    // The successful tuple's event should NOT be in failures
    // (it may or may not be — depends on whether the same eventId maps to only one tuple)
    // What matters is that the failed one IS reported
  });

  // -- Retries UnprocessedKeys from BatchGet --------------------------------

  it('retries UnprocessedKeys from BatchGet in update-stats', async () => {
    const trade = makeTrade({ tradeId: 'trade-1', openDate: '2026-04-06T09:30:00Z' });

    // queryTradesForDay: GSI returns the trade key
    ddbMock.on(QueryCommand).resolves({
      Items: [{ userId: 'user-1', tradeId: 'trade-1' }],
      LastEvaluatedKey: undefined,
    });

    // First BatchGet returns UnprocessedKeys, second succeeds
    ddbMock.on(BatchGetCommand)
      .resolvesOnce({
        Responses: { 'test-trades': [] },
        UnprocessedKeys: {
          'test-trades': {
            Keys: [{ userId: 'user-1', tradeId: 'trade-1' }],
          },
        },
      })
      .resolvesOnce({
        Responses: { 'test-trades': [trade] },
        UnprocessedKeys: undefined,
      });

    const event = makeStreamEvent([
      makeStreamRecord('INSERT', trade, undefined, 'evt-retry'),
    ]);

    await handler(event, {} as any, () => {});

    // Verify BatchGetCommand was called twice (initial + retry)
    const batchGetCalls = ddbMock.commandCalls(BatchGetCommand);
    expect(batchGetCalls).toHaveLength(2);

    // Verify the daily stats were written (PutCommand on daily-stats table)
    const dailyStatsPuts = ddbMock
      .commandCalls(PutCommand)
      .filter((c) => c.args[0].input.TableName === 'test-daily-stats');
    expect(dailyStatsPuts).toHaveLength(1);
    expect(dailyStatsPuts[0].args[0].input.Item!.userId).toBe('user-1');
  });

  // -- INSERT where accountId is numeric -1 (not string) --------------------

  it('skips trade when accountId is numeric -1 (not string)', async () => {
    const trade = makeTrade({ accountId: -1 });

    ddbMock.on(QueryCommand).resolves({
      Items: [],
      LastEvaluatedKey: undefined,
    });

    const event = makeStreamEvent([
      makeStreamRecord('INSERT', trade, undefined, 'evt-numeric-neg1'),
    ]);

    await handler(event, {} as any, () => {});

    // Should NOT have any queryTradesForDay calls (numeric -1 is skipped)
    const gsiQueries = ddbMock
      .commandCalls(QueryCommand)
      .filter((c) => c.args[0].input.IndexName === 'trades-by-date-gsi');
    expect(gsiQueries).toHaveLength(0);

    // Should NOT write daily stats
    const dailyStatsPuts = ddbMock
      .commandCalls(PutCommand)
      .filter((c) => c.args[0].input.TableName === 'test-daily-stats');
    expect(dailyStatsPuts).toHaveLength(0);
  });
});

describe('account balance with failed records and retries (BE-004)', () => {
  const t = (id: string, day: string, extra: Record<string, any> = {}) =>
    makeTrade({ tradeId: id, openDate: `${day}T09:30:00Z`, side: 'BUY', entryPrice: 100, exitPrice: 110, quantity: 1, ...extra }); // +10

  const balanceDeltas = () =>
    ddbMock.commandCalls(UpdateCommand)
      .filter((c) => c.args[0].input.TableName === 'test-accounts')
      .map((c) => [c.args[0].input.Key!.accountId, c.args[0].input.ExpressionAttributeValues![':delta']]);

  /** The day query for `failDay` throws, every other day returns its trade. */
  const stubDays = (trades: any[], failDay?: string) => {
    ddbMock.on(QueryCommand, { IndexName: 'trades-by-date-gsi' }).callsFake((input: any) => {
      const start: string = input.ExpressionAttributeValues[':start'];
      if (failDay && start === failDay) throw new Error('throttled');
      return { Items: trades.filter((x) => x.openDate.startsWith(start)).map((x) => ({ userId: x.userId, tradeId: x.tradeId })) };
    });
    ddbMock.on(BatchGetCommand).callsFake((input: any) => {
      const keys = input.RequestItems['test-trades'].Keys.map((k: any) => k.tradeId);
      return { Responses: { 'test-trades': trades.filter((x) => keys.includes(x.tradeId)) } };
    });
  };

  it('does not add the balance of the failed record or of any record after it; the redelivery adds each exactly once', async () => {
    const a = t('a', '2026-04-06');
    const b = t('b', '2026-04-07');
    const c = t('c', '2026-04-08');
    const all = [a, b, c];
    const batch = [
      makeStreamRecord('INSERT', a, undefined, 'seq-1'),
      makeStreamRecord('INSERT', b, undefined, 'seq-2'),
      makeStreamRecord('INSERT', c, undefined, 'seq-3'),
    ];

    // First delivery: the 2026-04-07 day write fails.
    stubDays(all, '2026-04-07');
    const first = (await handler(makeStreamEvent(batch), {} as any, () => {})) as any;
    expect(first.batchItemFailures).toEqual([{ itemIdentifier: 'seq-2' }]);
    // Only record 1 (before the first failure) is applied; records 2 and 3 come back with the redelivery.
    expect(balanceDeltas()).toEqual([['acc-1', 10]]);

    // Redelivery starts at the lowest failed record: [seq-2, seq-3], and now succeeds.
    ddbMock.resetHistory();
    stubDays(all);
    const retry = (await handler(makeStreamEvent(batch.slice(1)), {} as any, () => {})) as any;
    expect(retry.batchItemFailures).toEqual([]);
    expect(balanceDeltas()).toEqual([['acc-1', 20]]);
    // 10 (first run) + 20 (retry) = 30 = the three trades, each applied once.
  });

  it('a clean batch applies every delta once', async () => {
    const a = t('a', '2026-04-06');
    const b = t('b', '2026-04-07', { accountId: 'acc-2' });
    stubDays([a, b]);
    const res = (await handler(makeStreamEvent([
      makeStreamRecord('INSERT', a, undefined, 'seq-1'),
      makeStreamRecord('INSERT', b, undefined, 'seq-2'),
    ]), {} as any, () => {})) as any;
    expect(res.batchItemFailures).toEqual([]);
    expect(balanceDeltas().sort()).toEqual([['acc-1', 10], ['acc-2', 10]]);
  });

  it('a failure on the first record applies no delta at all', async () => {
    const a = t('a', '2026-04-06');
    const b = t('b', '2026-04-07');
    stubDays([a, b], '2026-04-06');
    const res = (await handler(makeStreamEvent([
      makeStreamRecord('INSERT', a, undefined, 'seq-1'),
      makeStreamRecord('INSERT', b, undefined, 'seq-2'),
    ]), {} as any, () => {})) as any;
    expect(res.batchItemFailures).toEqual([{ itemIdentifier: 'seq-1' }]);
    expect(balanceDeltas()).toEqual([]);
  });
});

describe('index query and invalid dates (BE-096, BE-027, BE-005)', () => {
  it('follows LastEvaluatedKey of the date index so later trades of a big day are included (BE-096)', async () => {
    const t1 = makeTrade({ tradeId: 't1' });
    const t2 = makeTrade({ tradeId: 't2' });
    ddbMock.on(QueryCommand, { IndexName: 'trades-by-date-gsi' })
      .resolvesOnce({ Items: [{ userId: 'user-1', tradeId: 't1' }], LastEvaluatedKey: { userId: 'user-1', tradeId: 't1', openDate: 'x' } })
      .resolvesOnce({ Items: [{ userId: 'user-1', tradeId: 't2' }] });
    ddbMock.on(BatchGetCommand).resolves({ Responses: { 'test-trades': [t1, t2] } });
    await handler(makeStreamEvent([makeStreamRecord('INSERT', t1, undefined, 'seq-1')]), {} as any, () => {});
    const gsiCalls = ddbMock.commandCalls(QueryCommand).filter((c) => c.args[0].input.IndexName === 'trades-by-date-gsi');
    expect(gsiCalls).toHaveLength(2);
    expect(gsiCalls[1].args[0].input.ExclusiveStartKey).toEqual({ userId: 'user-1', tradeId: 't1', openDate: 'x' });
    const put = ddbMock.commandCalls(PutCommand).find((c) => c.args[0].input.TableName === 'test-daily-stats')!.args[0].input.Item!;
    expect(put.tradeCount).toBe(2);
  });

  it('west of UTC the day query also reaches date-only openDate values (BE-027)', async () => {
    ddbMock.on(GetCommand, { TableName: 'test-prefs' }).resolves({ Item: { timeZone: 'America/New_York' } });
    const dateOnly = makeTrade({ tradeId: 'd', openDate: '2026-04-10' });
    ddbMock.on(QueryCommand).resolves({ Items: [dateOnly] });
    ddbMock.on(BatchGetCommand).resolves({ Responses: { 'test-trades': [dateOnly] } });
    await handler(makeStreamEvent([makeStreamRecord('INSERT', dateOnly, undefined, 'seq-d')]), {} as any, () => {});
    const q = ddbMock.commandCalls(QueryCommand).find((c) => c.args[0].input.IndexName === 'trades-by-date-gsi')!.args[0].input;
    expect(q.ExpressionAttributeValues).toMatchObject({ ':start': '2026-04-10', ':end': '2026-04-11T03:59:59.999Z' });
    const put = ddbMock.commandCalls(PutCommand).find((c) => c.args[0].input.TableName === 'test-daily-stats')!.args[0].input.Item!;
    expect(put).toMatchObject({ sk: 'acc-1#2026-04-10', tradeCount: 1 });
  });

  it('a trade with a date that is not a real day gets no day record and no failure (BE-005)', async () => {
    for (const openDate of ['2026-13-01', '2026-02-30T10:00:00Z', 'garbage']) {
      ddbMock.resetHistory();
      const bad = makeTrade({ tradeId: 'bad', openDate });
      ddbMock.on(QueryCommand).resolves({ Items: [bad] });
      ddbMock.on(BatchGetCommand).resolves({ Responses: { 'test-trades': [bad] } });
      const res = (await handler(makeStreamEvent([makeStreamRecord('INSERT', bad, undefined, 'seq-bad')]), {} as any, () => {})) as any;
      expect(res.batchItemFailures).toEqual([]);
      expect(ddbMock.commandCalls(PutCommand).filter((c) => c.args[0].input.TableName === 'test-daily-stats')).toHaveLength(0);
    }
  });
});

describe('dirty flag for the rebuild job (BE-009)', () => {
  it('flags each affected user once, in the #dirty partition of the daily stats table', async () => {
    const a = makeTrade({ tradeId: 'a' });
    const b = makeTrade({ tradeId: 'b', accountId: 'acc-2' });
    const c = makeTrade({ tradeId: 'c', userId: 'user-2' });
    ddbMock.on(QueryCommand).resolves({ Items: [] });
    ddbMock.on(BatchGetCommand).resolves({ Responses: { 'test-trades': [] } });
    await handler(makeStreamEvent([
      makeStreamRecord('INSERT', a, undefined, 's1'),
      makeStreamRecord('INSERT', b, undefined, 's2'),
      makeStreamRecord('INSERT', c, undefined, 's3'),
    ]), {} as any, () => {});
    const flags = ddbMock.commandCalls(UpdateCommand)
      .filter((x) => x.args[0].input.TableName === 'test-daily-stats')
      .map((x) => x.args[0].input.Key);
    expect(flags).toEqual([{ userId: '#dirty', sk: 'user-1' }, { userId: '#dirty', sk: 'user-2' }]);
  });

  it('a failing flag write does not fail the batch', async () => {
    const a = makeTrade({ tradeId: 'a' });
    ddbMock.on(QueryCommand).resolves({ Items: [] });
    ddbMock.on(BatchGetCommand).resolves({ Responses: { 'test-trades': [] } });
    ddbMock.on(UpdateCommand, { TableName: 'test-daily-stats' }).rejects(new Error('throttled'));
    const res = (await handler(makeStreamEvent([makeStreamRecord('INSERT', a, undefined, 's1')]), {} as any, () => {})) as any;
    expect(res.batchItemFailures).toEqual([]);
  });
});
