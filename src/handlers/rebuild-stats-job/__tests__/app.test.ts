import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBDocumentClient, ScanCommand, PutCommand, GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';

// Stub env before importing handler
vi.stubEnv('TRADES_TABLE', 'test-trades');
vi.stubEnv('TRADE_STATS_TABLE', 'test-stats');
vi.stubEnv('ACCOUNTS_TABLE', 'test-accounts');

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
});

describe('rebuild-stats-job handler', () => {
  // ── Success ─────────────────────────────────────────────────

  it('rebuilds stats and returns rebuiltUsers count', async () => {
    ddbMock.on(ScanCommand).resolves({
      Items: [
        makeTrade({ tradeId: 't1', entryPrice: 100, exitPrice: 110, quantity: 10, side: 'BUY' }),
        makeTrade({ tradeId: 't2', entryPrice: 200, exitPrice: 190, quantity: 5, side: 'BUY' }),
      ],
      LastEvaluatedKey: undefined,
    });

    const result = await handler();

    expect(result).toEqual({ rebuiltUsers: 1 });
    // Should have called PutCommand to write stats
    const putCalls = ddbMock.commandCalls(PutCommand);
    expect(putCalls.length).toBeGreaterThanOrEqual(1);

    const statsItem = putCalls[0].args[0].input.Item;
    expect(statsItem.userId).toBe('user-1');
    expect(statsItem.tradeCount).toBe(2);
    // Trade 1: (110-100)*10 = 100 (win); Trade 2: (190-200)*5 = -50 (loss)
    expect(statsItem.realizedPnL).toBe(50);
    expect(statsItem.wins).toBe(1);
    expect(statsItem.losses).toBe(1);
    expect(statsItem.bestWin).toBe(100);
    expect(statsItem.worstLoss).toBe(-50);
  });

  it('returns rebuiltUsers: 0 when trades table is empty', async () => {
    ddbMock.on(ScanCommand).resolves({
      Items: [],
      LastEvaluatedKey: undefined,
    });

    const result = await handler();

    expect(result).toEqual({ rebuiltUsers: 0 });
    expect(ddbMock.commandCalls(PutCommand)).toHaveLength(0);
  });

  // ── PnL calculation ─────────────────────────────────────────

  it('calculates PnL correctly for BUY trades: (exit - entry) * qty', async () => {
    ddbMock.on(ScanCommand).resolves({
      Items: [
        makeTrade({ side: 'BUY', entryPrice: 50, exitPrice: 75, quantity: 4 }),
      ],
      LastEvaluatedKey: undefined,
    });

    await handler();

    const putCalls = ddbMock.commandCalls(PutCommand);
    const statsItem = putCalls[0].args[0].input.Item;
    // (75 - 50) * 4 = 100
    expect(statsItem.realizedPnL).toBe(100);
    expect(statsItem.wins).toBe(1);
  });

  it('calculates PnL correctly for SELL trades: (entry - exit) * qty', async () => {
    ddbMock.on(ScanCommand).resolves({
      Items: [
        makeTrade({ side: 'SELL', entryPrice: 200, exitPrice: 180, quantity: 2 }),
      ],
      LastEvaluatedKey: undefined,
    });

    await handler();

    const putCalls = ddbMock.commandCalls(PutCommand);
    const statsItem = putCalls[0].args[0].input.Item;
    // (200 - 180) * 2 = 40
    expect(statsItem.realizedPnL).toBe(40);
    expect(statsItem.wins).toBe(1);
  });

  // ── Skipping ────────────────────────────────────────────────

  it('skips trades with accountId = "-1"', async () => {
    ddbMock.on(ScanCommand).resolves({
      Items: [
        makeTrade({ accountId: '-1', entryPrice: 100, exitPrice: 200, quantity: 1 }),
        makeTrade({ tradeId: 't2', accountId: 'acc-1', entryPrice: 100, exitPrice: 110, quantity: 10 }),
      ],
      LastEvaluatedKey: undefined,
    });

    await handler();

    const putCalls = ddbMock.commandCalls(PutCommand);
    const statsItem = putCalls[0].args[0].input.Item;
    // Only the second trade should count for PnL
    expect(statsItem.realizedPnL).toBe(100);
    expect(statsItem.tradeCount).toBe(2); // tradeCount is total trades
    expect(statsItem.wins).toBe(1);
  });

  // ── Account balance updates ─────────────────────────────────

  it('updates account balance = initialBalance + totalPnL', async () => {
    ddbMock.on(ScanCommand).resolves({
      Items: [
        makeTrade({ accountId: 'acc-1', side: 'BUY', entryPrice: 100, exitPrice: 120, quantity: 5 }),
      ],
      LastEvaluatedKey: undefined,
    });
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
    ddbMock.on(ScanCommand).resolves({
      Items: [
        makeTrade({ userId: 'user-1', tradeId: 't1', accountId: 'acc-1', side: 'BUY', entryPrice: 100, exitPrice: 110, quantity: 10 }),
        makeTrade({ userId: 'user-2', tradeId: 't2', accountId: 'acc-2', side: 'SELL', entryPrice: 50, exitPrice: 40, quantity: 20 }),
      ],
      LastEvaluatedKey: undefined,
    });

    const result = await handler();

    expect(result).toEqual({ rebuiltUsers: 2 });
    const putCalls = ddbMock.commandCalls(PutCommand);
    expect(putCalls).toHaveLength(2);

    const userIds = putCalls.map((c) => c.args[0].input.Item.userId);
    expect(userIds).toContain('user-1');
    expect(userIds).toContain('user-2');
  });
});
