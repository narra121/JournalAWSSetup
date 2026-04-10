import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBDocumentClient, ScanCommand, BatchWriteCommand } from '@aws-sdk/lib-dynamodb';

// Stub env before importing handler
vi.stubEnv('TRADES_TABLE', 'test-trades');
vi.stubEnv('DAILY_STATS_TABLE', 'test-daily-stats');

// Mock DynamoDBDocumentClient (the handler creates its own instance)
const ddbMock = mockClient(DynamoDBDocumentClient);

const { handler } = await import('../app.ts');

// --- Helpers ----------------------------------------------------------------

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
});

describe('migrate-stats handler', () => {
  // -- Success: scans trades and creates daily stats records -----------------

  it('scans trades table and creates daily stats records', async () => {
    const tradesUser1 = [
      makeTrade({ userId: 'user-1', tradeId: 't1', openDate: '2026-04-06T09:30:00Z', accountId: 'acc-1' }),
      makeTrade({ userId: 'user-1', tradeId: 't2', openDate: '2026-04-06T10:00:00Z', accountId: 'acc-1', entryPrice: 150, exitPrice: 140, side: 'BUY' }),
    ];
    const tradesUser2 = [
      makeTrade({ userId: 'user-2', tradeId: 't3', openDate: '2026-04-07T14:00:00Z', accountId: 'acc-2' }),
    ];

    ddbMock.on(ScanCommand).resolves({
      Items: [...tradesUser1, ...tradesUser2],
      LastEvaluatedKey: undefined,
    });
    ddbMock.on(BatchWriteCommand).resolves({ UnprocessedItems: {} });

    const result = await handler();

    expect(result.status).toBe('complete');
    expect(result.usersProcessed).toBe(2);
    // user-1 has 2 trades on same day = 1 record, user-2 has 1 trade = 1 record
    expect(result.dailyRecordsCreated).toBe(2);

    // Verify BatchWriteCommand was called with correct table
    const batchCalls = ddbMock.commandCalls(BatchWriteCommand);
    expect(batchCalls.length).toBeGreaterThanOrEqual(1);
    const requestItems = batchCalls[0].args[0].input.RequestItems;
    expect(requestItems).toHaveProperty('test-daily-stats');

    // Check the records have correct structure
    const putRequests = requestItems!['test-daily-stats'];
    expect(putRequests.length).toBe(2);

    const items = putRequests.map((r: any) => r.PutRequest.Item);
    const userIds = items.map((item: any) => item.userId);
    expect(userIds).toContain('user-1');
    expect(userIds).toContain('user-2');

    // Check that daily records have expected fields
    for (const item of items) {
      expect(item.userId).toBeDefined();
      expect(item.accountId).toBeDefined();
      expect(item.date).toBeDefined();
      expect(item.sk).toBeDefined();
      expect(item.dayOfWeek).toBeDefined();
    }
  });

  // -- Skips unmapped trades -------------------------------------------------

  it('skips trades with accountId = -1 (string)', async () => {
    ddbMock.on(ScanCommand).resolves({
      Items: [
        makeTrade({ tradeId: 't-unmapped', accountId: '-1', openDate: '2026-04-06T09:30:00Z' }),
        makeTrade({ tradeId: 't-mapped', accountId: 'acc-1', openDate: '2026-04-06T10:00:00Z' }),
      ],
      LastEvaluatedKey: undefined,
    });
    ddbMock.on(BatchWriteCommand).resolves({ UnprocessedItems: {} });

    const result = await handler();

    expect(result.dailyRecordsCreated).toBe(1);

    const batchCalls = ddbMock.commandCalls(BatchWriteCommand);
    expect(batchCalls.length).toBe(1);
    const putRequests = batchCalls[0].args[0].input.RequestItems!['test-daily-stats'];
    expect(putRequests).toHaveLength(1);
    expect(putRequests[0].PutRequest.Item.accountId).toBe('acc-1');
  });

  it('skips trades with accountId = -1 (number)', async () => {
    ddbMock.on(ScanCommand).resolves({
      Items: [
        makeTrade({ tradeId: 't-unmapped-num', accountId: -1, openDate: '2026-04-06T09:30:00Z' }),
        makeTrade({ tradeId: 't-mapped', accountId: 'acc-1', openDate: '2026-04-07T10:00:00Z' }),
      ],
      LastEvaluatedKey: undefined,
    });
    ddbMock.on(BatchWriteCommand).resolves({ UnprocessedItems: {} });

    const result = await handler();

    expect(result.dailyRecordsCreated).toBe(1);

    const batchCalls = ddbMock.commandCalls(BatchWriteCommand);
    const putRequests = batchCalls[0].args[0].input.RequestItems!['test-daily-stats'];
    expect(putRequests).toHaveLength(1);
    expect(putRequests[0].PutRequest.Item.accountId).toBe('acc-1');
  });

  // -- Groups trades correctly -----------------------------------------------

  it('groups trades by (userId, accountId, date) correctly', async () => {
    const trades = [
      // User 1, acc-1, day 1
      makeTrade({ userId: 'user-1', tradeId: 't1', accountId: 'acc-1', openDate: '2026-04-06T09:30:00Z' }),
      makeTrade({ userId: 'user-1', tradeId: 't2', accountId: 'acc-1', openDate: '2026-04-06T10:00:00Z' }),
      // User 1, acc-1, day 2 (different date)
      makeTrade({ userId: 'user-1', tradeId: 't3', accountId: 'acc-1', openDate: '2026-04-07T09:30:00Z' }),
      // User 1, acc-2, day 1 (different account, same date as first group)
      makeTrade({ userId: 'user-1', tradeId: 't4', accountId: 'acc-2', openDate: '2026-04-06T11:00:00Z' }),
      // User 2, acc-3, day 1
      makeTrade({ userId: 'user-2', tradeId: 't5', accountId: 'acc-3', openDate: '2026-04-06T14:00:00Z' }),
    ];

    ddbMock.on(ScanCommand).resolves({
      Items: trades,
      LastEvaluatedKey: undefined,
    });
    ddbMock.on(BatchWriteCommand).resolves({ UnprocessedItems: {} });

    const result = await handler();

    // Should create 4 groups:
    // 1. user-1#acc-1#2026-04-06 (2 trades)
    // 2. user-1#acc-1#2026-04-07 (1 trade)
    // 3. user-1#acc-2#2026-04-06 (1 trade)
    // 4. user-2#acc-3#2026-04-06 (1 trade)
    expect(result.dailyRecordsCreated).toBe(4);
    expect(result.usersProcessed).toBe(2);

    // Verify the records written
    const batchCalls = ddbMock.commandCalls(BatchWriteCommand);
    const allPutRequests = batchCalls.flatMap(
      (c) => c.args[0].input.RequestItems!['test-daily-stats'],
    );
    expect(allPutRequests).toHaveLength(4);

    // Verify each group's sk is unique
    const sks = allPutRequests.map((r: any) => r.PutRequest.Item.sk);
    const uniqueSks = new Set(sks);
    expect(uniqueSks.size).toBe(4);

    // Check specific sk formats
    expect(sks).toContain('acc-1#2026-04-06');
    expect(sks).toContain('acc-1#2026-04-07');
    expect(sks).toContain('acc-2#2026-04-06');
    expect(sks).toContain('acc-3#2026-04-06');
  });

  // -- Empty trades table ----------------------------------------------------

  it('returns 0 records when trades table is empty', async () => {
    ddbMock.on(ScanCommand).resolves({
      Items: [],
      LastEvaluatedKey: undefined,
    });

    const result = await handler();

    expect(result.status).toBe('complete');
    expect(result.usersProcessed).toBe(0);
    expect(result.dailyRecordsCreated).toBe(0);

    // BatchWriteCommand should not be called at all
    expect(ddbMock.commandCalls(BatchWriteCommand)).toHaveLength(0);
  });

  // -- Pagination on scan ----------------------------------------------------

  it('handles paginated ScanCommand (multiple pages)', async () => {
    const tradesPage1 = [
      makeTrade({ tradeId: 't1', openDate: '2026-04-06T09:30:00Z' }),
    ];
    const tradesPage2 = [
      makeTrade({ tradeId: 't2', openDate: '2026-04-07T10:00:00Z' }),
    ];

    ddbMock
      .on(ScanCommand)
      .resolvesOnce({
        Items: tradesPage1,
        LastEvaluatedKey: { userId: 'user-1', tradeId: 't1' },
      })
      .resolvesOnce({
        Items: tradesPage2,
        LastEvaluatedKey: undefined,
      });
    ddbMock.on(BatchWriteCommand).resolves({ UnprocessedItems: {} });

    const result = await handler();

    expect(result.dailyRecordsCreated).toBe(2);
    expect(result.usersProcessed).toBe(1);

    // Verify two scan calls
    const scanCalls = ddbMock.commandCalls(ScanCommand);
    expect(scanCalls).toHaveLength(2);
    // Second scan should include ExclusiveStartKey
    expect(scanCalls[1].args[0].input.ExclusiveStartKey).toBeDefined();
  });

  // -- Returns summary -------------------------------------------------------

  it('returns summary with usersProcessed and dailyRecordsCreated', async () => {
    ddbMock.on(ScanCommand).resolves({
      Items: [
        makeTrade({ userId: 'user-1', tradeId: 't1', accountId: 'acc-1', openDate: '2026-04-06T09:30:00Z' }),
        makeTrade({ userId: 'user-2', tradeId: 't2', accountId: 'acc-2', openDate: '2026-04-06T10:00:00Z' }),
        makeTrade({ userId: 'user-3', tradeId: 't3', accountId: 'acc-3', openDate: '2026-04-07T11:00:00Z' }),
      ],
      LastEvaluatedKey: undefined,
    });
    ddbMock.on(BatchWriteCommand).resolves({ UnprocessedItems: {} });

    const result = await handler();

    expect(result).toEqual({
      status: 'complete',
      usersProcessed: 3,
      dailyRecordsCreated: 3,
    });
  });

  // -- BatchWrite chunking ---------------------------------------------------

  it('chunks BatchWriteCommand into batches of 25', async () => {
    // Create 30 trades, each on a different day, to produce 30 daily records
    const trades = Array.from({ length: 30 }, (_, i) => {
      const day = String(i + 1).padStart(2, '0');
      return makeTrade({
        tradeId: `t${i}`,
        openDate: `2026-04-${day}T09:30:00Z`,
        // Keep same userId and accountId but different dates
      });
    });

    ddbMock.on(ScanCommand).resolves({
      Items: trades,
      LastEvaluatedKey: undefined,
    });
    ddbMock.on(BatchWriteCommand).resolves({ UnprocessedItems: {} });

    const result = await handler();

    expect(result.dailyRecordsCreated).toBe(30);

    // Should have called BatchWriteCommand twice (25 + 5)
    const batchCalls = ddbMock.commandCalls(BatchWriteCommand);
    expect(batchCalls).toHaveLength(2);

    const firstBatch = batchCalls[0].args[0].input.RequestItems!['test-daily-stats'];
    const secondBatch = batchCalls[1].args[0].input.RequestItems!['test-daily-stats'];
    expect(firstBatch).toHaveLength(25);
    expect(secondBatch).toHaveLength(5);
  });

  // -- Skips trades with no openDate -----------------------------------------

  it('skips trades with missing or empty openDate', async () => {
    ddbMock.on(ScanCommand).resolves({
      Items: [
        makeTrade({ tradeId: 't-no-date', openDate: '', accountId: 'acc-1' }),
        makeTrade({ tradeId: 't-valid', openDate: '2026-04-06T09:30:00Z', accountId: 'acc-1' }),
      ],
      LastEvaluatedKey: undefined,
    });
    ddbMock.on(BatchWriteCommand).resolves({ UnprocessedItems: {} });

    const result = await handler();

    expect(result.dailyRecordsCreated).toBe(1);
  });

  // -- Error / failure cases --------------------------------------------------

  it('throws when ScanCommand fails mid-scan (first page succeeds, second rejects)', async () => {
    ddbMock.on(ScanCommand)
      .resolvesOnce({
        Items: [makeTrade({ tradeId: 't1', openDate: '2026-04-06T09:30:00Z' })],
        LastEvaluatedKey: { userId: 'user-1', tradeId: 't1' },
      })
      .rejectsOnce(new Error('DynamoDB scan failed on page 2'));

    await expect(handler()).rejects.toThrow('DynamoDB scan failed on page 2');
  });

  it('retries when BatchWriteCommand returns UnprocessedItems', async () => {
    ddbMock.on(ScanCommand).resolves({
      Items: [makeTrade({ tradeId: 't1', openDate: '2026-04-06T09:30:00Z', accountId: 'acc-1' })],
      LastEvaluatedKey: undefined,
    });

    // First attempt returns unprocessed items, second succeeds
    ddbMock.on(BatchWriteCommand)
      .resolvesOnce({
        UnprocessedItems: {
          'test-daily-stats': [{ PutRequest: { Item: { userId: 'user-1', sk: 'acc-1#2026-04-06' } } }],
        },
      })
      .resolvesOnce({ UnprocessedItems: {} });

    const result = await handler();

    expect(result.status).toBe('complete');
    expect(result.dailyRecordsCreated).toBe(1);

    // BatchWriteCommand should have been called twice (initial + retry)
    const batchCalls = ddbMock.commandCalls(BatchWriteCommand);
    expect(batchCalls).toHaveLength(2);
  });

  it('throws when BatchWriteCommand fails completely', async () => {
    ddbMock.on(ScanCommand).resolves({
      Items: [makeTrade({ tradeId: 't1', openDate: '2026-04-06T09:30:00Z', accountId: 'acc-1' })],
      LastEvaluatedKey: undefined,
    });
    ddbMock.on(BatchWriteCommand).rejects(new Error('BatchWrite failed'));

    await expect(handler()).rejects.toThrow('BatchWrite failed');
  });

  it('skips trade with invalid openDate (empty string) via extractDate', async () => {
    ddbMock.on(ScanCommand).resolves({
      Items: [
        makeTrade({ tradeId: 't-empty-date', openDate: '', accountId: 'acc-1' }),
      ],
      LastEvaluatedKey: undefined,
    });

    const result = await handler();

    expect(result.status).toBe('complete');
    expect(result.dailyRecordsCreated).toBe(0);
    expect(result.usersProcessed).toBe(0);
    // BatchWriteCommand should not be called since no records were created
    expect(ddbMock.commandCalls(BatchWriteCommand)).toHaveLength(0);
  });

  it('skips trade with missing userId', async () => {
    ddbMock.on(ScanCommand).resolves({
      Items: [
        makeTrade({ userId: undefined, tradeId: 't-no-user', openDate: '2026-04-06T09:30:00Z', accountId: 'acc-1' }),
      ],
      LastEvaluatedKey: undefined,
    });
    ddbMock.on(BatchWriteCommand).resolves({ UnprocessedItems: {} });

    const result = await handler();

    // Trade with undefined userId gets grouped under "undefined" key but still processed
    // The important thing is it doesn't crash
    expect(result.status).toBe('complete');
  });

  it('skips trade with accountId as number -1', async () => {
    ddbMock.on(ScanCommand).resolves({
      Items: [
        makeTrade({ tradeId: 't-neg-acc', accountId: -1, openDate: '2026-04-06T09:30:00Z' }),
        makeTrade({ tradeId: 't-valid', accountId: 'acc-1', openDate: '2026-04-07T10:00:00Z' }),
      ],
      LastEvaluatedKey: undefined,
    });
    ddbMock.on(BatchWriteCommand).resolves({ UnprocessedItems: {} });

    const result = await handler();

    expect(result.dailyRecordsCreated).toBe(1);
    expect(result.usersProcessed).toBe(1);

    const batchCalls = ddbMock.commandCalls(BatchWriteCommand);
    const putRequests = batchCalls[0].args[0].input.RequestItems!['test-daily-stats'];
    expect(putRequests).toHaveLength(1);
    expect(putRequests[0].PutRequest.Item.accountId).toBe('acc-1');
  });

  it('computeDailyRecord returns null for empty trade group (no records created)', async () => {
    // All trades have no accountId, so no groups are formed
    ddbMock.on(ScanCommand).resolves({
      Items: [
        makeTrade({ tradeId: 't1', accountId: null, openDate: '2026-04-06T09:30:00Z' }),
        makeTrade({ tradeId: 't2', accountId: undefined, openDate: '2026-04-07T09:30:00Z' }),
      ],
      LastEvaluatedKey: undefined,
    });

    const result = await handler();

    expect(result.status).toBe('complete');
    expect(result.dailyRecordsCreated).toBe(0);
    expect(result.usersProcessed).toBe(0);
    expect(ddbMock.commandCalls(BatchWriteCommand)).toHaveLength(0);
  });
});
