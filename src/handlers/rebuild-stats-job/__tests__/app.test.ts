import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBDocumentClient, ScanCommand, PutCommand, GetCommand, UpdateCommand, QueryCommand, DeleteCommand } from '@aws-sdk/lib-dynamodb';

// Stub env before importing handler
vi.stubEnv('TRADES_TABLE', 'test-trades');
vi.stubEnv('ACCOUNTS_TABLE', 'test-accounts');
vi.stubEnv('DAILY_STATS_TABLE', 'test-daily-stats');

// Mock DynamoDBDocumentClient (the handler creates its own instance)
const ddbMock = mockClient(DynamoDBDocumentClient);

const { handler } = await import('../app.ts');

// ─── Helpers ────────────────────────────────────────────────────

function makeTrade(overrides: Record<string, any> = {}) {
  return {
    userId: 'user-1',
    tradeId: 'trade-1',
    symbol: 'AAPL',
    side: 'BUY',
    entryPrice: 100,
    exitPrice: 110,
    quantity: 10,
    accountId: 'acc-1',
    ...overrides,
  };
}

/** Stub the initial ScanCommand on DAILY_STATS_TABLE to return recently-changed users. */
function stubRecentUsers(userIds: string[]) {
  ddbMock.on(ScanCommand, { TableName: 'test-daily-stats' }).resolves({
    Items: userIds.map(userId => ({ userId, lastUpdated: new Date().toISOString() })),
    LastEvaluatedKey: undefined,
  });
}

/** Stub the QueryCommand on TRADES_TABLE to return trades for a user. */
function stubUserTrades(trades: any[]) {
  ddbMock.on(QueryCommand, { TableName: 'test-trades' }).resolves({
    Items: trades,
    LastEvaluatedKey: undefined,
  });
}

// ─── Tests ──────────────────────────────────────────────────────

beforeEach(() => {
  ddbMock.reset();
  // Default: GetCommand for account returns initialBalance
  ddbMock.on(GetCommand).resolves({
    Item: { initialBalance: 10000 },
  });
  // Default: UpdateCommand succeeds
  ddbMock.on(UpdateCommand).resolves({});
  // Default: PutCommand succeeds
  ddbMock.on(PutCommand).resolves({});
  // Default: QueryCommand for daily stats orphan cleanup returns empty
  ddbMock.on(QueryCommand, { TableName: 'test-daily-stats' }).resolves({ Items: [] });
  // Default: QueryCommand for trades returns empty
  ddbMock.on(QueryCommand, { TableName: 'test-trades' }).resolves({ Items: [], LastEvaluatedKey: undefined });
  // Default: DeleteCommand succeeds
  ddbMock.on(DeleteCommand).resolves({});
  // Default: ScanCommand on daily stats returns empty (no recent changes)
  ddbMock.on(ScanCommand, { TableName: 'test-daily-stats' }).resolves({
    Items: [],
    LastEvaluatedKey: undefined,
  });
});

describe('rebuild-stats-job handler', () => {
  // ── Targeted approach ──────────────────────────────────────────

  it('returns early when no users have recent changes', async () => {
    // Default scan returns empty — no recent changes
    const result = await handler();

    expect(result).toEqual({ rebuiltUsers: 0, skipped: 'no recent changes' });
    // Should NOT query trades table at all
    expect(ddbMock.commandCalls(QueryCommand, { TableName: 'test-trades' })).toHaveLength(0);
    expect(ddbMock.commandCalls(PutCommand)).toHaveLength(0);
  });

  it('logs start message', async () => {
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await handler();

    expect(consoleSpy).toHaveBeenCalledWith('rebuild-stats-job started', expect.objectContaining({ timestamp: expect.any(String) }));
    consoleSpy.mockRestore();
  });

  it('warns but processes ALL users when above threshold', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    // Generate 1500 unique users from the daily stats scan
    const manyUsers = Array.from({ length: 1500 }, (_, i) => ({
      userId: `user-${i}`,
      lastUpdated: new Date().toISOString(),
    }));
    ddbMock.on(ScanCommand, { TableName: 'test-daily-stats' }).resolves({
      Items: manyUsers,
      LastEvaluatedKey: undefined,
    });

    const result = await handler();

    // All 1500 users should be processed — no cap
    expect(result).toEqual({ rebuiltUsers: 1500 });
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('1500 users need rebuilding'),
    );

    warnSpy.mockRestore();
    logSpy.mockRestore();
  });

  // ── Success ─────────────────────────────────────────────────

  it('rebuilds stats and returns rebuiltUsers count', async () => {
    stubRecentUsers(['user-1']);
    stubUserTrades([
      makeTrade({ tradeId: 't1', entryPrice: 100, exitPrice: 110, quantity: 10, side: 'BUY', openDate: '2026-01-15T10:00:00Z' }),
      makeTrade({ tradeId: 't2', entryPrice: 200, exitPrice: 190, quantity: 5, side: 'BUY', openDate: '2026-01-15T11:00:00Z' }),
    ]);

    const result = await handler();

    expect(result).toEqual({ rebuiltUsers: 1 });
    // Trade 1: (110-100)*10 = 100; Trade 2: (190-200)*5 = -50; total PnL = 50
    // Account balance should be initialBalance(10000) + 50 = 10050
    const updateCalls = ddbMock.commandCalls(UpdateCommand);
    expect(updateCalls.length).toBeGreaterThanOrEqual(1);
    expect(updateCalls[0].args[0].input.ExpressionAttributeValues[':balance']).toBe(10050);
  });

  it('handles user with no trades (all deleted since last daily stats write)', async () => {
    stubRecentUsers(['user-1']);
    // User appears in daily stats but has no trades anymore
    stubUserTrades([]);

    const result = await handler();

    expect(result).toEqual({ rebuiltUsers: 1 });
    // No account balance updates since there are no trades
    expect(ddbMock.commandCalls(UpdateCommand)).toHaveLength(0);
    // No daily stats PutCommands since there are no trades to group
    expect(ddbMock.commandCalls(PutCommand)).toHaveLength(0);
  });

  // ── PnL calculation ─────────────────────────────────────────

  it('calculates PnL correctly for BUY trades: (exit - entry) * qty', async () => {
    stubRecentUsers(['user-1']);
    stubUserTrades([
      makeTrade({ side: 'BUY', entryPrice: 50, exitPrice: 75, quantity: 4 }),
    ]);
    ddbMock.on(GetCommand).resolves({ Item: { initialBalance: 1000 } });

    await handler();

    const updateCalls = ddbMock.commandCalls(UpdateCommand);
    expect(updateCalls.length).toBeGreaterThanOrEqual(1);
    // (75 - 50) * 4 = 100; balance = 1000 + 100 = 1100
    expect(updateCalls[0].args[0].input.ExpressionAttributeValues[':balance']).toBe(1100);
  });

  it('calculates PnL correctly for SELL trades: (entry - exit) * qty', async () => {
    stubRecentUsers(['user-1']);
    stubUserTrades([
      makeTrade({ side: 'SELL', entryPrice: 200, exitPrice: 180, quantity: 2 }),
    ]);
    ddbMock.on(GetCommand).resolves({ Item: { initialBalance: 1000 } });

    await handler();

    const updateCalls = ddbMock.commandCalls(UpdateCommand);
    expect(updateCalls.length).toBeGreaterThanOrEqual(1);
    // (200 - 180) * 2 = 40; balance = 1000 + 40 = 1040
    expect(updateCalls[0].args[0].input.ExpressionAttributeValues[':balance']).toBe(1040);
  });

  // ── Skipping ────────────────────────────────────────────────

  it('skips trades with accountId = "-1"', async () => {
    stubRecentUsers(['user-1']);
    stubUserTrades([
      makeTrade({ accountId: '-1', entryPrice: 100, exitPrice: 200, quantity: 1 }),
      makeTrade({ tradeId: 't2', accountId: 'acc-1', entryPrice: 100, exitPrice: 110, quantity: 10 }),
    ]);
    ddbMock.on(GetCommand).resolves({ Item: { initialBalance: 5000 } });

    await handler();

    // Only acc-1 should get a balance update, not the "-1" account
    const updateCalls = ddbMock.commandCalls(UpdateCommand);
    expect(updateCalls.length).toBe(1);
    expect(updateCalls[0].args[0].input.Key).toEqual({ userId: 'user-1', accountId: 'acc-1' });
    // Only the second trade counts: (110-100)*10 = 100; balance = 5000 + 100 = 5100
    expect(updateCalls[0].args[0].input.ExpressionAttributeValues[':balance']).toBe(5100);
  });

  // ── Account balance updates ─────────────────────────────────

  it('updates account balance = initialBalance + totalPnL', async () => {
    stubRecentUsers(['user-1']);
    stubUserTrades([
      makeTrade({ accountId: 'acc-1', side: 'BUY', entryPrice: 100, exitPrice: 120, quantity: 5 }),
    ]);
    ddbMock.on(GetCommand).resolves({
      Item: { initialBalance: 10000 },
    });

    await handler();

    const updateCalls = ddbMock.commandCalls(UpdateCommand);
    expect(updateCalls.length).toBeGreaterThanOrEqual(1);
    const updateInput = updateCalls[0].args[0].input;
    expect(updateInput.Key).toEqual({ userId: 'user-1', accountId: 'acc-1' });
    // PnL = (120-100)*5 = 100; balance = 10000 + 100 = 10100
    expect(updateInput.ExpressionAttributeValues[':balance']).toBe(10100);
  });

  // ── Multiple users ──────────────────────────────────────────

  it('processes multiple users independently', async () => {
    stubRecentUsers(['user-1', 'user-2']);
    // QueryCommand on trades table returns trades matching the queried user
    ddbMock.on(QueryCommand, { TableName: 'test-trades' })
      .callsFake((input: any) => {
        const userId = input.ExpressionAttributeValues[':u'];
        if (userId === 'user-1') {
          return {
            Items: [makeTrade({ userId: 'user-1', tradeId: 't1', accountId: 'acc-1', side: 'BUY', entryPrice: 100, exitPrice: 110, quantity: 10 })],
            LastEvaluatedKey: undefined,
          };
        }
        if (userId === 'user-2') {
          return {
            Items: [makeTrade({ userId: 'user-2', tradeId: 't2', accountId: 'acc-2', side: 'SELL', entryPrice: 50, exitPrice: 40, quantity: 20 })],
            LastEvaluatedKey: undefined,
          };
        }
        return { Items: [], LastEvaluatedKey: undefined };
      });
    ddbMock.on(GetCommand).resolves({ Item: { initialBalance: 10000 } });

    const result = await handler();

    expect(result).toEqual({ rebuiltUsers: 2 });
    // Both users should get account balance updates
    const updateCalls = ddbMock.commandCalls(UpdateCommand);
    expect(updateCalls.length).toBe(2);
    const accountIds = updateCalls.map((c) => c.args[0].input.Key.accountId);
    expect(accountIds).toContain('acc-1');
    expect(accountIds).toContain('acc-2');
  });

  // ── Error / failure cases ──────────────────────────────────

  it('throws when ScanCommand fails', async () => {
    ddbMock.on(ScanCommand).rejects(new Error('DynamoDB scan failed'));

    await expect(handler()).rejects.toThrow('DynamoDB scan failed');
  });

  it('throws when PutCommand fails writing daily stats', async () => {
    stubRecentUsers(['user-1']);
    stubUserTrades([makeTrade({ openDate: '2026-01-15T10:00:00Z' })]);
    ddbMock.on(PutCommand).rejects(new Error('PutCommand failed'));

    await expect(handler()).rejects.toThrow('PutCommand failed');
  });

  it('logs error and continues when GetCommand fails fetching account initialBalance', async () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    stubRecentUsers(['user-1']);
    stubUserTrades([
      makeTrade({ tradeId: 't1', accountId: 'acc-1' }),
      makeTrade({ tradeId: 't2', accountId: 'acc-2', userId: 'user-1' }),
    ]);
    ddbMock.on(GetCommand).rejects(new Error('GetCommand failed'));

    const result = await handler();

    // Handler should complete despite GetCommand errors (try/catch per account)
    expect(result).toEqual({ rebuiltUsers: 1 });
    expect(consoleSpy).toHaveBeenCalled();
    consoleSpy.mockRestore();
  });

  it('logs error and continues when UpdateCommand fails for account balance update', async () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    stubRecentUsers(['user-1']);
    stubUserTrades([makeTrade({ tradeId: 't1', accountId: 'acc-1' })]);
    ddbMock.on(GetCommand).resolves({ Item: { initialBalance: 10000 } });
    ddbMock.on(UpdateCommand).rejects(new Error('UpdateCommand failed'));

    const result = await handler();

    // Handler should complete despite UpdateCommand errors (try/catch per account)
    expect(result).toEqual({ rebuiltUsers: 1 });
    expect(consoleSpy).toHaveBeenCalled();
    consoleSpy.mockRestore();
  });

  it('treats trade with missing side field (side: null) as SELL-like (falls into else branch)', async () => {
    stubRecentUsers(['user-1']);
    stubUserTrades([
      makeTrade({ tradeId: 't1', side: null, pnl: undefined, entryPrice: 100, exitPrice: 110, quantity: 10 }),
    ]);
    ddbMock.on(GetCommand).resolves({ Item: { initialBalance: 1000 } });

    await handler();

    // When side is null, the handler falls into the else branch of the ternary:
    // (entryPrice - exitPrice) * quantity = (100 - 110) * 10 = -100
    // balance = 1000 + (-100) = 900
    const updateCalls = ddbMock.commandCalls(UpdateCommand);
    expect(updateCalls.length).toBeGreaterThanOrEqual(1);
    expect(updateCalls[0].args[0].input.ExpressionAttributeValues[':balance']).toBe(900);
  });

  it('processes trade with quantity = 0 resulting in pnl = 0', async () => {
    stubRecentUsers(['user-1']);
    stubUserTrades([
      makeTrade({ tradeId: 't1', side: 'BUY', entryPrice: 100, exitPrice: 110, quantity: 0 }),
    ]);
    ddbMock.on(GetCommand).resolves({ Item: { initialBalance: 1000 } });

    await handler();

    // (110 - 100) * 0 = 0; balance = 1000 + 0 = 1000
    const updateCalls = ddbMock.commandCalls(UpdateCommand);
    expect(updateCalls.length).toBeGreaterThanOrEqual(1);
    expect(updateCalls[0].args[0].input.ExpressionAttributeValues[':balance']).toBe(1000);
  });

  it('handles trade with negative prices', async () => {
    stubRecentUsers(['user-1']);
    stubUserTrades([
      makeTrade({ tradeId: 't1', side: 'BUY', entryPrice: -1, exitPrice: 5, quantity: 10 }),
    ]);
    ddbMock.on(GetCommand).resolves({ Item: { initialBalance: 1000 } });

    await handler();

    // (5 - (-1)) * 10 = 60; balance = 1000 + 60 = 1060
    const updateCalls = ddbMock.commandCalls(UpdateCommand);
    expect(updateCalls.length).toBeGreaterThanOrEqual(1);
    expect(updateCalls[0].args[0].input.ExpressionAttributeValues[':balance']).toBe(1060);
  });

  it('skips balance update when account not found (GetCommand returns no Item)', async () => {
    stubRecentUsers(['user-1']);
    stubUserTrades([makeTrade({ tradeId: 't1', accountId: 'acc-missing' })]);
    ddbMock.on(GetCommand).resolves({ Item: undefined });

    const result = await handler();

    expect(result).toEqual({ rebuiltUsers: 1 });
    // UpdateCommand should never be called since account was not found
    expect(ddbMock.commandCalls(UpdateCommand)).toHaveLength(0);
  });

  it('deduplicates userIds from daily stats scan', async () => {
    // Same user appears multiple times in daily stats (multiple records updated)
    ddbMock.on(ScanCommand, { TableName: 'test-daily-stats' }).resolves({
      Items: [
        { userId: 'user-1', lastUpdated: new Date().toISOString() },
        { userId: 'user-1', lastUpdated: new Date().toISOString() },
        { userId: 'user-1', lastUpdated: new Date().toISOString() },
      ],
      LastEvaluatedKey: undefined,
    });
    stubUserTrades([makeTrade({ tradeId: 't1' })]);

    const result = await handler();

    // Should only process user-1 once
    expect(result).toEqual({ rebuiltUsers: 1 });
  });
});
