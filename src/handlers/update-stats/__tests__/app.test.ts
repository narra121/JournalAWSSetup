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
vi.stubEnv('INSIGHTS_CACHE_TABLE', 'test-insights-cache');

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
    expect(item.userId).toBe('user-1');
    expect(item.accountId).toBe('acc-1');
    expect(item.date).toBe('2026-04-06');
    expect(item.sk).toBe('acc-1#2026-04-06');
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
      (c) => c.args[0].input.ExpressionAttributeValues[':d'],
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
      (c) => c.args[0].input.ExpressionAttributeValues[':d'] === '2026-04-06',
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
    expect(gsiQueries[0].args[0].input.ExpressionAttributeValues[':u']).toBe('user-1');
    expect(gsiQueries[0].args[0].input.ExpressionAttributeValues[':d']).toBe('2026-04-06');
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

  it('syncs new symbol into SavedOptions on INSERT', async () => {
    const trade = makeTrade({ symbol: 'TSLA' });

    ddbMock.on(QueryCommand).resolves({ Items: [trade], LastEvaluatedKey: undefined });
    ddbMock.on(BatchGetCommand).resolves({ Responses: { 'test-trades': [trade] } });
    ddbMock.on(GetCommand).resolves({ Item: { symbols: ['AAPL'] } });

    const event = makeStreamEvent([
      makeStreamRecord('INSERT', trade, undefined, 'evt-symbol-sync'),
    ]);

    await handler(event, {} as any, () => {});

    // Should have called UpdateCommand on saved-options table with merged symbols
    const optionUpdates = ddbMock
      .commandCalls(UpdateCommand)
      .filter((c) => c.args[0].input.TableName === 'test-saved-options');
    expect(optionUpdates).toHaveLength(1);
    expect(optionUpdates[0].args[0].input.ExpressionAttributeValues![':symbols']).toEqual(['AAPL', 'TSLA']);
  });

  it('skips symbol sync when symbol already exists in SavedOptions', async () => {
    const trade = makeTrade({ symbol: 'AAPL' });

    ddbMock.on(QueryCommand).resolves({ Items: [trade], LastEvaluatedKey: undefined });
    ddbMock.on(BatchGetCommand).resolves({ Responses: { 'test-trades': [trade] } });
    ddbMock.on(GetCommand).resolves({ Item: { symbols: ['AAPL', 'MSFT'] } });

    const event = makeStreamEvent([
      makeStreamRecord('INSERT', trade, undefined, 'evt-symbol-dup'),
    ]);

    await handler(event, {} as any, () => {});

    // No UpdateCommand on saved-options since symbol already present
    const optionUpdates = ddbMock
      .commandCalls(UpdateCommand)
      .filter((c) => c.args[0].input.TableName === 'test-saved-options');
    expect(optionUpdates).toHaveLength(0);
  });

  it('syncs symbol on MODIFY but not on REMOVE', async () => {
    const oldTrade = makeTrade({ symbol: 'AAPL' });
    const newTrade = makeTrade({ symbol: 'GOOG' });
    const removedTrade = makeTrade({ symbol: 'NFLX' });

    ddbMock.on(QueryCommand).resolves({ Items: [newTrade], LastEvaluatedKey: undefined });
    ddbMock.on(BatchGetCommand).resolves({ Responses: { 'test-trades': [newTrade] } });
    ddbMock.on(GetCommand).resolves({ Item: { symbols: [] } });

    const event = makeStreamEvent([
      makeStreamRecord('MODIFY', newTrade, oldTrade, 'evt-modify-sym'),
      makeStreamRecord('REMOVE', undefined, removedTrade, 'evt-remove-sym'),
    ]);

    await handler(event, {} as any, () => {});

    // Only GOOG should be synced (from MODIFY), not NFLX (from REMOVE)
    const optionUpdates = ddbMock
      .commandCalls(UpdateCommand)
      .filter((c) => c.args[0].input.TableName === 'test-saved-options');
    expect(optionUpdates).toHaveLength(1);
    expect(optionUpdates[0].args[0].input.ExpressionAttributeValues![':symbols']).toEqual(['GOOG']);
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
        const date = input.ExpressionAttributeValues[':d'];
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
    expect(dailyStatsPuts[0].args[0].input.Item.userId).toBe('user-1');
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

// ---------------------------------------------------------------------------
// Insights cache invalidation
// ---------------------------------------------------------------------------

describe('insights cache invalidation', () => {
  it('marks insights cache as stale when trade is inserted', async () => {
    const trade = makeTrade();

    ddbMock.on(QueryCommand, { TableName: 'test-insights-cache' }).resolves({
      Items: [{ userId: 'user-1', cacheKey: 'insights-weekly' }],
    });
    ddbMock.on(QueryCommand, { IndexName: 'trades-by-date-gsi' }).resolves({
      Items: [trade],
      LastEvaluatedKey: undefined,
    });
    ddbMock.on(BatchGetCommand).resolves({
      Responses: { 'test-trades': [trade] },
    });

    const event = makeStreamEvent([
      makeStreamRecord('INSERT', trade, undefined, 'evt-cache-insert'),
    ]);

    await handler(event, {} as any, () => {});

    // Verify QueryCommand was called on the insights cache table with the userId
    const cacheQueries = ddbMock
      .commandCalls(QueryCommand)
      .filter((c) => c.args[0].input.TableName === 'test-insights-cache');
    expect(cacheQueries.length).toBeGreaterThanOrEqual(1);
    expect(cacheQueries[0].args[0].input.ExpressionAttributeValues![':uid']).toBe('user-1');

    // Verify UpdateCommand was called on the insights cache table with stale = true
    const cacheUpdates = ddbMock
      .commandCalls(UpdateCommand)
      .filter((c) => c.args[0].input.TableName === 'test-insights-cache');
    expect(cacheUpdates).toHaveLength(1);
    expect(cacheUpdates[0].args[0].input.Key).toEqual({ userId: 'user-1', cacheKey: 'insights-weekly' });
    expect(cacheUpdates[0].args[0].input.UpdateExpression).toBe('SET stale = :t');
    expect(cacheUpdates[0].args[0].input.ExpressionAttributeValues![':t']).toBe(true);
  });

  it('marks insights cache as stale when trade is modified', async () => {
    const oldTrade = makeTrade({ exitPrice: 110 });
    const newTrade = makeTrade({ exitPrice: 120 });

    ddbMock.on(QueryCommand, { TableName: 'test-insights-cache' }).resolves({
      Items: [{ userId: 'user-1', cacheKey: 'insights-monthly' }],
    });
    ddbMock.on(QueryCommand, { IndexName: 'trades-by-date-gsi' }).resolves({
      Items: [newTrade],
      LastEvaluatedKey: undefined,
    });
    ddbMock.on(BatchGetCommand).resolves({
      Responses: { 'test-trades': [newTrade] },
    });

    const event = makeStreamEvent([
      makeStreamRecord('MODIFY', newTrade, oldTrade, 'evt-cache-modify'),
    ]);

    await handler(event, {} as any, () => {});

    const cacheUpdates = ddbMock
      .commandCalls(UpdateCommand)
      .filter((c) => c.args[0].input.TableName === 'test-insights-cache');
    expect(cacheUpdates).toHaveLength(1);
    expect(cacheUpdates[0].args[0].input.Key).toEqual({ userId: 'user-1', cacheKey: 'insights-monthly' });
    expect(cacheUpdates[0].args[0].input.ExpressionAttributeValues![':t']).toBe(true);
  });

  it('marks insights cache as stale when trade is deleted', async () => {
    const trade = makeTrade();

    ddbMock.on(QueryCommand, { TableName: 'test-insights-cache' }).resolves({
      Items: [{ userId: 'user-1', cacheKey: 'insights-daily' }],
    });
    ddbMock.on(QueryCommand, { IndexName: 'trades-by-date-gsi' }).resolves({
      Items: [],
      LastEvaluatedKey: undefined,
    });

    const event = makeStreamEvent([
      makeStreamRecord('REMOVE', undefined, trade, 'evt-cache-remove'),
    ]);

    await handler(event, {} as any, () => {});

    const cacheUpdates = ddbMock
      .commandCalls(UpdateCommand)
      .filter((c) => c.args[0].input.TableName === 'test-insights-cache');
    expect(cacheUpdates).toHaveLength(1);
    expect(cacheUpdates[0].args[0].input.Key).toEqual({ userId: 'user-1', cacheKey: 'insights-daily' });
    expect(cacheUpdates[0].args[0].input.ExpressionAttributeValues![':t']).toBe(true);
  });

  it('handles multiple cache entries for a user', async () => {
    const trade = makeTrade();

    ddbMock.on(QueryCommand, { TableName: 'test-insights-cache' }).resolves({
      Items: [
        { userId: 'user-1', cacheKey: 'insights-daily' },
        { userId: 'user-1', cacheKey: 'insights-weekly' },
        { userId: 'user-1', cacheKey: 'insights-monthly' },
      ],
    });
    ddbMock.on(QueryCommand, { IndexName: 'trades-by-date-gsi' }).resolves({
      Items: [trade],
      LastEvaluatedKey: undefined,
    });
    ddbMock.on(BatchGetCommand).resolves({
      Responses: { 'test-trades': [trade] },
    });

    const event = makeStreamEvent([
      makeStreamRecord('INSERT', trade, undefined, 'evt-cache-multi'),
    ]);

    await handler(event, {} as any, () => {});

    // Verify 3 UpdateCommands were sent to the insights cache table
    const cacheUpdates = ddbMock
      .commandCalls(UpdateCommand)
      .filter((c) => c.args[0].input.TableName === 'test-insights-cache');
    expect(cacheUpdates).toHaveLength(3);

    const updatedKeys = cacheUpdates.map((c) => c.args[0].input.Key!.cacheKey);
    expect(updatedKeys).toContain('insights-daily');
    expect(updatedKeys).toContain('insights-weekly');
    expect(updatedKeys).toContain('insights-monthly');

    // Each update should set stale = true
    for (const call of cacheUpdates) {
      expect(call.args[0].input.ExpressionAttributeValues![':t']).toBe(true);
    }
  });

  it('handles empty cache gracefully', async () => {
    const trade = makeTrade();

    ddbMock.on(QueryCommand, { TableName: 'test-insights-cache' }).resolves({
      Items: [],
    });
    ddbMock.on(QueryCommand, { IndexName: 'trades-by-date-gsi' }).resolves({
      Items: [trade],
      LastEvaluatedKey: undefined,
    });
    ddbMock.on(BatchGetCommand).resolves({
      Responses: { 'test-trades': [trade] },
    });

    const event = makeStreamEvent([
      makeStreamRecord('INSERT', trade, undefined, 'evt-cache-empty'),
    ]);

    const result = (await handler(event, {} as any, () => {})) as any;

    // Handler should not fail
    expect(result.batchItemFailures).toHaveLength(0);

    // No UpdateCommand should be sent to insights cache table
    const cacheUpdates = ddbMock
      .commandCalls(UpdateCommand)
      .filter((c) => c.args[0].input.TableName === 'test-insights-cache');
    expect(cacheUpdates).toHaveLength(0);
  });

  it('cache invalidation failure does not break stats processing', async () => {
    const trade = makeTrade();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    ddbMock.on(QueryCommand, { TableName: 'test-insights-cache' }).rejects(
      new Error('Insights cache unavailable'),
    );
    ddbMock.on(QueryCommand, { IndexName: 'trades-by-date-gsi' }).resolves({
      Items: [trade],
      LastEvaluatedKey: undefined,
    });
    ddbMock.on(BatchGetCommand).resolves({
      Responses: { 'test-trades': [trade] },
    });

    const event = makeStreamEvent([
      makeStreamRecord('INSERT', trade, undefined, 'evt-cache-fail'),
    ]);

    const result = (await handler(event, {} as any, () => {})) as any;

    // Stats processing should still succeed (no batch failures)
    expect(result.batchItemFailures).toHaveLength(0);

    // Daily stats should still have been written
    const dailyStatsPuts = ddbMock
      .commandCalls(PutCommand)
      .filter((c) => c.args[0].input.TableName === 'test-daily-stats');
    expect(dailyStatsPuts.length).toBeGreaterThanOrEqual(1);

    // console.warn should have been called with the failure message
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('Failed to invalidate insights cache'),
      expect.any(Error),
    );

    warnSpy.mockRestore();
  });

  it('invalidates cache for all affected users', async () => {
    const trade1 = makeTrade({ userId: 'user-1', tradeId: 'trade-1' });
    const trade2 = makeTrade({ userId: 'user-2', tradeId: 'trade-2', accountId: 'acc-2' });

    ddbMock.on(QueryCommand, { TableName: 'test-insights-cache' }).callsFake((input: any) => {
      const uid = input.ExpressionAttributeValues[':uid'];
      return {
        Items: [{ userId: uid, cacheKey: `cache-${uid}` }],
      };
    });
    ddbMock.on(QueryCommand, { IndexName: 'trades-by-date-gsi' }).resolves({
      Items: [trade1],
      LastEvaluatedKey: undefined,
    });
    ddbMock.on(BatchGetCommand).resolves({
      Responses: { 'test-trades': [trade1] },
    });

    const event = makeStreamEvent([
      makeStreamRecord('INSERT', trade1, undefined, 'evt-user1-cache'),
      makeStreamRecord('INSERT', trade2, undefined, 'evt-user2-cache'),
    ]);

    await handler(event, {} as any, () => {});

    // Verify cache was queried for both users
    const cacheQueries = ddbMock
      .commandCalls(QueryCommand)
      .filter((c) => c.args[0].input.TableName === 'test-insights-cache');
    expect(cacheQueries).toHaveLength(2);

    const queriedUserIds = cacheQueries.map(
      (c) => c.args[0].input.ExpressionAttributeValues![':uid'],
    );
    expect(queriedUserIds).toContain('user-1');
    expect(queriedUserIds).toContain('user-2');

    // Verify UpdateCommand was called for both users' cache entries
    const cacheUpdates = ddbMock
      .commandCalls(UpdateCommand)
      .filter((c) => c.args[0].input.TableName === 'test-insights-cache');
    expect(cacheUpdates).toHaveLength(2);

    const updatedUserIds = cacheUpdates.map((c) => c.args[0].input.Key!.userId);
    expect(updatedUserIds).toContain('user-1');
    expect(updatedUserIds).toContain('user-2');

    // Both should set stale = true
    for (const call of cacheUpdates) {
      expect(call.args[0].input.ExpressionAttributeValues![':t']).toBe(true);
    }
  });
});
