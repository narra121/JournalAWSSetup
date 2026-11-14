import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBDocumentClient, QueryCommand, UpdateCommand, DeleteCommand, BatchWriteCommand, GetCommand } from '@aws-sdk/lib-dynamodb';

vi.stubEnv('TRADES_TABLE', 'test-trades');
vi.stubEnv('ACCOUNTS_TABLE', 'test-accounts');
vi.stubEnv('DAILY_STATS_TABLE', 'test-daily-stats');
vi.stubEnv('USER_PREFERENCES_TABLE', 'test-prefs');

// The handler creates its own DocumentClient; the mock covers every instance.
const ddbMock = mockClient(DynamoDBDocumentClient);

const { handler, rebuildForUser } = await import('../app.ts');
const { computeDailyRecord } = await import('../../../shared/stats-aggregator');

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
    openDate: '2026-04-06T09:30:00Z',
    ...overrides,
  };
}

interface World {
  dirty?: { sk: string; dirtyAt: string }[];
  trades?: Record<string, any[]>; // by userId
  accounts?: Record<string, any[]>; // by userId
  stored?: Record<string, { sk: string; tradeHash?: string }[]>; // daily stats by userId
}

/** Answers every Query by table / partition from a small in-memory world. */
function stubWorld(w: World) {
  ddbMock.on(QueryCommand).callsFake((input: any) => {
    const v = input.ExpressionAttributeValues ?? {};
    if (input.TableName === 'test-daily-stats') {
      if (v[':pk'] === '#dirty') return { Items: (w.dirty ?? []).map((d) => ({ userId: '#dirty', ...d })) };
      return { Items: (w.stored?.[v[':uid']] ?? []).map((i) => ({ userId: v[':uid'], ...i })) };
    }
    if (input.TableName === 'test-trades') return { Items: w.trades?.[v[':u']] ?? [] };
    if (input.TableName === 'test-accounts') return { Items: w.accounts?.[v[':u']] ?? [] };
    return { Items: [] };
  });
}

const dirty = (...ids: string[]) => ids.map((id) => ({ sk: id, dirtyAt: '2026-04-06T10:00:00.000Z' }));
const balanceWrites = () => ddbMock.commandCalls(UpdateCommand).filter((c) => c.args[0].input.TableName === 'test-accounts').map((c) => c.args[0].input);
const batches = () => ddbMock.commandCalls(BatchWriteCommand).map((c) => c.args[0].input.RequestItems!['test-daily-stats'] as any[]);
const putItems = () => batches().flat().filter((r) => r.PutRequest).map((r) => r.PutRequest.Item);
const deletedKeys = () => batches().flat().filter((r) => r.DeleteRequest).map((r) => r.DeleteRequest.Key);

beforeEach(() => {
  ddbMock.reset();
  ddbMock.on(UpdateCommand).resolves({});
  ddbMock.on(DeleteCommand).resolves({});
  ddbMock.on(BatchWriteCommand).resolves({});
  stubWorld({});
});

describe('rebuild-stats-job handler', () => {
  // ── Selecting users (BE-009) ───────────────────────────────────

  it('returns early when no user is flagged, without scanning or reading trades', async () => {
    const result = await handler();

    expect(result).toEqual({ rebuiltUsers: 0, skipped: 'no recent changes' });
    expect(ddbMock.commandCalls(QueryCommand).every((c) => c.args[0].input.TableName === 'test-daily-stats')).toBe(true);
    expect(ddbMock.commandCalls(QueryCommand)).toHaveLength(1);
    expect(batches()).toHaveLength(0);
  });

  it('never scans the daily stats table: users come from the #dirty partition', async () => {
    stubWorld({ dirty: dirty('user-1') });
    await handler();
    const first = ddbMock.commandCalls(QueryCommand)[0].args[0].input;
    expect(first.KeyConditionExpression).toBe('userId = :pk');
    expect(first.ExpressionAttributeValues).toEqual({ ':pk': '#dirty' });
  });

  it('logs start message', async () => {
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await handler();
    expect(consoleSpy).toHaveBeenCalledWith('rebuild-stats-job started', expect.objectContaining({ timestamp: expect.any(String) }));
    consoleSpy.mockRestore();
  });

  it('warns but processes ALL users when above threshold', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    stubWorld({ dirty: dirty(...Array.from({ length: 1500 }, (_, i) => `user-${i}`)) });

    const result = await handler();

    expect(result).toEqual({ rebuiltUsers: 1500 });
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('1500 users need rebuilding'));
    warnSpy.mockRestore();
  });

  it('clears the flag after a successful rebuild so the user is not picked again (BE-009)', async () => {
    stubWorld({ dirty: dirty('user-1'), trades: { 'user-1': [makeTrade()] }, accounts: { 'user-1': [{ accountId: 'acc-1', initialBalance: 1000 }] } });

    const result = await handler();

    expect(result).toEqual({ rebuiltUsers: 1 });
    const del = ddbMock.commandCalls(DeleteCommand)[0].args[0].input;
    expect(del).toMatchObject({
      TableName: 'test-daily-stats',
      Key: { userId: '#dirty', sk: 'user-1' },
      ConditionExpression: 'dirtyAt = :seen',
      ExpressionAttributeValues: { ':seen': '2026-04-06T10:00:00.000Z' },
    });
  });

  it('a flag that update-stats set again during the rebuild stays (conditional delete fails quietly)', async () => {
    stubWorld({ dirty: dirty('user-1') });
    ddbMock.on(DeleteCommand).rejects(Object.assign(new Error('changed'), { name: 'ConditionalCheckFailedException' }));
    await expect(handler()).resolves.toEqual({ rebuiltUsers: 1 });
  });

  it('keeps the flag of a user whose rebuild fails and throws after the others are done', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    stubWorld({ dirty: dirty('user-ok', 'user-bad'), trades: { 'user-ok': [makeTrade({ userId: 'user-ok' })], 'user-bad': [makeTrade({ userId: 'user-bad' })] } });
    ddbMock.on(BatchWriteCommand).callsFake((input: any) => {
      const items = input.RequestItems['test-daily-stats'];
      if (items.some((r: any) => r.PutRequest?.Item.userId === 'user-bad')) throw new Error('write failed');
      return {};
    });

    await expect(handler()).rejects.toThrow('write failed');

    const cleared = ddbMock.commandCalls(DeleteCommand).map((c) => c.args[0].input.Key!.sk);
    expect(cleared).toEqual(['user-ok']);
    err.mockRestore();
  });

  it('processes users concurrently in batches of 5', async () => {
    let running = 0; let peak = 0;
    const ids = Array.from({ length: 12 }, (_, i) => `user-${i}`);
    stubWorld({ dirty: dirty(...ids) });
    ddbMock.on(QueryCommand, { TableName: 'test-trades' }).callsFake(async () => {
      running++; peak = Math.max(peak, running);
      await new Promise((r) => setTimeout(r, 5));
      running--;
      return { Items: [] };
    });
    const result = await handler();
    expect(result).toEqual({ rebuiltUsers: 12 });
    expect(peak).toBeLessThanOrEqual(5);
  });

  // ── Daily stats (BE-009, BE-028) ───────────────────────────────

  describe('daily stats', () => {
    const trade = makeTrade({ updatedAt: '2026-04-06T10:00:00.000Z' });
    const hashOf = (trades: any[]) => computeDailyRecord('user-1', 'acc-1', '2026-04-06', trades, null)!.tradeHash;

    it('writes a day record per (account, day) with BatchWrite', async () => {
      stubWorld({ trades: { 'user-1': [trade, makeTrade({ tradeId: 't2', openDate: '2026-04-07T09:30:00Z' }), makeTrade({ tradeId: 't3', accountId: 'acc-2' })] } });
      await rebuildForUser('user-1');
      expect(putItems().map((i) => i.sk).sort()).toEqual(['acc-1#2026-04-06', 'acc-1#2026-04-07', 'acc-2#2026-04-06']);
    });

    it('does not rewrite a day whose tradeHash is unchanged, so lastUpdated does not move (BE-009)', async () => {
      stubWorld({ trades: { 'user-1': [trade] }, stored: { 'user-1': [{ sk: 'acc-1#2026-04-06', tradeHash: hashOf([trade]) }] } });
      await rebuildForUser('user-1');
      expect(batches()).toHaveLength(0);
    });

    it('rewrites a day whose hash differs, and every day when forced', async () => {
      stubWorld({ trades: { 'user-1': [trade] }, stored: { 'user-1': [{ sk: 'acc-1#2026-04-06', tradeHash: 'old' }] } });
      await rebuildForUser('user-1');
      expect(putItems()).toHaveLength(1);

      ddbMock.resetHistory();
      stubWorld({ trades: { 'user-1': [trade] }, stored: { 'user-1': [{ sk: 'acc-1#2026-04-06', tradeHash: hashOf([trade]) }] } });
      await rebuildForUser('user-1', { force: true });
      expect(putItems()).toHaveLength(1);
    });

    it('deletes day records that no longer have trades', async () => {
      stubWorld({ trades: { 'user-1': [trade] }, stored: { 'user-1': [{ sk: 'acc-1#2026-04-06', tradeHash: 'x' }, { sk: 'acc-1#2026-03-01', tradeHash: 'y' }] } });
      await rebuildForUser('user-1');
      expect(deletedKeys()).toEqual([{ userId: 'user-1', sk: 'acc-1#2026-03-01' }]);
    });

    it('a user with no trades gets their stored day records removed', async () => {
      stubWorld({ trades: { 'user-1': [] }, stored: { 'user-1': [{ sk: 'acc-1#2026-04-06' }] } });
      await rebuildForUser('user-1');
      expect(putItems()).toHaveLength(0);
      expect(deletedKeys()).toEqual([{ userId: 'user-1', sk: 'acc-1#2026-04-06' }]);
    });

    it('skips unassigned trades, soft-deleted trades and dates that are not real days', async () => {
      stubWorld({ trades: { 'user-1': [
        makeTrade({ tradeId: 'a', accountId: '-1' }),
        makeTrade({ tradeId: 'b', deletedAt: '2026-04-07T00:00:00Z' }),
        makeTrade({ tradeId: 'c', openDate: '2026-13-01' }),
        makeTrade({ tradeId: 'd', openDate: 'garbage' }),
      ] } });
      await rebuildForUser('user-1');
      expect(putItems()).toHaveLength(0);
    });

    it('reads every field the processors need, so the hash and the segments match the stream (BE-028)', async () => {
      stubWorld({});
      await rebuildForUser('user-1');
      const q = ddbMock.commandCalls(QueryCommand).find((c) => c.args[0].input.TableName === 'test-trades')!.args[0].input;
      for (const field of ['assetClass', 'contractMultiplier', 'updatedAt', 'fees', 'importSource', 'brokenRuleIds', 'mistakes', 'lessons', 'deletedAt']) {
        expect(q.ProjectionExpression).toContain(field);
      }
    });

    it('a futures trade keeps its asset class and multiplier in the rebuilt record', async () => {
      const fut = makeTrade({ assetClass: 'futures', contractMultiplier: 50, stopLoss: 90, pnl: 500, quantity: 1 });
      stubWorld({ trades: { 'user-1': [fut] } });
      await rebuildForUser('user-1');
      const rec = putItems()[0];
      expect(rec.segments.assetClass.futures.trades).toBe(1);
      expect(rec.segments.assetClass.Unknown).toBeUndefined();
    });
  });

  // ── Balances (BE-029, BE-037) ──────────────────────────────────

  describe('account balances', () => {
    const account = (over: Record<string, any> = {}) => ({ accountId: 'acc-1', initialBalance: 10000, balance: 10000, tradeCount: 0, updatedAt: 'u1', ...over });

    it('balance = initialBalance + P&L of the live trades (BUY and SELL formulas)', async () => {
      stubWorld({
        trades: { 'user-1': [makeTrade(), makeTrade({ tradeId: 't2', side: 'SELL', entryPrice: 100, exitPrice: 90, quantity: 5 })] },
        accounts: { 'user-1': [account()] },
      });
      await rebuildForUser('user-1');
      expect(balanceWrites()).toHaveLength(1);
      expect(balanceWrites()[0].ExpressionAttributeValues).toMatchObject({ ':balance': 10150 });
    });

    it('uses the stored pnl, and ignores a trade whose side is neither BUY nor SELL (shared calcPnL)', async () => {
      stubWorld({
        trades: { 'user-1': [makeTrade({ pnl: 25 }), makeTrade({ tradeId: 't2', side: 'LONG' }), makeTrade({ tradeId: 't3', side: null })] },
        accounts: { 'user-1': [account()] },
      });
      await rebuildForUser('user-1');
      expect(balanceWrites()[0].ExpressionAttributeValues).toMatchObject({ ':balance': 10025 });
    });

    it('applies the contract multiplier when no pnl is stored', async () => {
      stubWorld({ trades: { 'user-1': [makeTrade({ quantity: 2, entryPrice: 100, exitPrice: 110, contractMultiplier: 50 })] }, accounts: { 'user-1': [account()] } });
      await rebuildForUser('user-1');
      expect(balanceWrites()[0].ExpressionAttributeValues).toMatchObject({ ':balance': 11000 });
    });

    it('resets an account whose trades are all gone to its initial balance', async () => {
      stubWorld({ trades: { 'user-1': [] }, accounts: { 'user-1': [account({ balance: 12345 })] } });
      await rebuildForUser('user-1');
      expect(balanceWrites()[0].ExpressionAttributeValues).toMatchObject({ ':balance': 10000 });
    });

    it('does not write an account whose balance and counters are already right', async () => {
      stubWorld({ trades: { 'user-1': [makeTrade()] }, accounts: { 'user-1': [account({ balance: 10100, tradeCount: 1, lastTradeDate: '2026-04-06' })] } });
      await rebuildForUser('user-1');
      expect(balanceWrites()).toHaveLength(0);
    });

    it('does not count unassigned trades and ignores accounts the user no longer has', async () => {
      stubWorld({ trades: { 'user-1': [makeTrade({ accountId: '-1' }), makeTrade({ tradeId: 't2', accountId: 'gone' })] }, accounts: { 'user-1': [account()] } });
      await rebuildForUser('user-1');
      expect(balanceWrites()).toHaveLength(0);
    });

    it('writes only if the account is unchanged since it was read (stream ADDs and edits bump updatedAt)', async () => {
      stubWorld({ trades: { 'user-1': [makeTrade()] }, accounts: { 'user-1': [account({ balance: 0 })] } });
      await rebuildForUser('user-1');
      const w = balanceWrites()[0];
      expect(w.ConditionExpression).toBe('#updatedAt = :seen');
      expect(w.ExpressionAttributeValues).toMatchObject({ ':seen': 'u1' });
    });

    it('an account without updatedAt is written only while it still has none', async () => {
      stubWorld({ trades: { 'user-1': [makeTrade()] }, accounts: { 'user-1': [account({ balance: 0, updatedAt: undefined })] } });
      await rebuildForUser('user-1');
      expect(balanceWrites()[0].ConditionExpression).toBe('attribute_not_exists(#updatedAt)');
    });

    it('re-reads accounts and trades and recomputes when a write lost the race', async () => {
      let reads = 0;
      ddbMock.on(QueryCommand).callsFake((input: any) => {
        if (input.TableName === 'test-accounts') { reads++; return { Items: [account({ balance: 0, updatedAt: `u${reads}` })] }; }
        if (input.TableName === 'test-trades') return { Items: reads === 1 ? [makeTrade()] : [makeTrade(), makeTrade({ tradeId: 't2' })] };
        return { Items: [] };
      });
      let writes = 0;
      ddbMock.on(UpdateCommand).callsFake(() => {
        writes++;
        if (writes === 1) throw Object.assign(new Error('raced'), { name: 'ConditionalCheckFailedException' });
        return {};
      });

      await rebuildForUser('user-1');

      expect(reads).toBe(2);
      expect(balanceWrites().map((w) => w.ExpressionAttributeValues![':balance'])).toEqual([10100, 10200]);
    });

    // H6: an unsettled balance must keep the user flagged, so it fails the rebuild once the day records are written.
    it('gives up after three attempts and fails the rebuild instead of looping or reporting success', async () => {
      stubWorld({ trades: { 'user-1': [makeTrade()] }, accounts: { 'user-1': [account({ balance: 0 })] } });
      ddbMock.on(UpdateCommand).rejects(Object.assign(new Error('raced'), { name: 'ConditionalCheckFailedException' }));
      await expect(rebuildForUser('user-1')).rejects.toThrow('balances of user-1 kept changing');
      expect(balanceWrites()).toHaveLength(3);
      expect(putItems()).toHaveLength(1);
    });

    it('a failing balance write is logged and fails the rebuild, after the other accounts and the daily stats were done', async () => {
      const err = vi.spyOn(console, 'error').mockImplementation(() => {});
      stubWorld({
        trades: { 'user-1': [makeTrade(), makeTrade({ tradeId: 't2', accountId: 'acc-2' })] },
        accounts: { 'user-1': [account({ balance: 0 }), account({ accountId: 'acc-2', balance: 0 })] },
      });
      ddbMock.on(UpdateCommand).callsFake((input: any) => {
        if (input.Key.accountId === 'acc-1') throw new Error('throttled');
        return {};
      });
      await expect(rebuildForUser('user-1')).rejects.toThrow('throttled');
      expect(err).toHaveBeenCalledWith(expect.stringContaining('Failed to update balance for account acc-1'), expect.any(Error));
      expect(balanceWrites().map((w) => w.Key!.accountId)).toEqual(['acc-1', 'acc-2']);
      expect(putItems()).toHaveLength(2);
      err.mockRestore();
    });

    it('the job keeps the #dirty flag of a user whose balances kept changing, and fails', async () => {
      stubWorld({ dirty: dirty('user-1'), trades: { 'user-1': [makeTrade()] }, accounts: { 'user-1': [account({ balance: 0 })] } });
      ddbMock.on(UpdateCommand).rejects(Object.assign(new Error('raced'), { name: 'ConditionalCheckFailedException' }));
      await expect(handler()).rejects.toThrow('kept changing');
      expect(ddbMock.commandCalls(DeleteCommand)).toHaveLength(0);
    });

    it('the job keeps the #dirty flag of a user whose balance write failed, and fails', async () => {
      const err = vi.spyOn(console, 'error').mockImplementation(() => {});
      stubWorld({ dirty: dirty('user-1'), trades: { 'user-1': [makeTrade()] }, accounts: { 'user-1': [account({ balance: 0 })] } });
      ddbMock.on(UpdateCommand).rejects(new Error('throttled'));
      await expect(handler()).rejects.toThrow('throttled');
      expect(ddbMock.commandCalls(DeleteCommand)).toHaveLength(0);
      err.mockRestore();
    });

    it('an account id such as __proto__ is an ordinary key', async () => {
      stubWorld({ trades: { 'user-1': [makeTrade({ accountId: '__proto__' })] }, accounts: { 'user-1': [account({ accountId: '__proto__', balance: 0 })] } });
      await rebuildForUser('user-1');
      expect(balanceWrites()[0].ExpressionAttributeValues).toMatchObject({ ':balance': 10100 });
      expect(({} as any).totalPnl).toBeUndefined();
    });
  });
});

describe('account trade count and last trade day (M1)', () => {
  const account = (over: Record<string, any> = {}) => ({ accountId: 'acc-1', initialBalance: 10000, balance: 10000, updatedAt: 'u1', ...over });
  const counters = () => balanceWrites().map((w) => ({
    id: w.Key!.accountId,
    count: w.ExpressionAttributeValues![':count'],
    last: w.ExpressionAttributeValues![':lastDay'],
  }));

  it('sets tradeCount and lastTradeDate of an account that has neither (no manual backfill), with the balance in one conditional write', async () => {
    stubWorld({
      trades: { 'user-1': [makeTrade(), makeTrade({ tradeId: 't2', openDate: '2026-04-09T09:30:00Z' }), makeTrade({ tradeId: 't3', openDate: '2026-04-07T09:30:00Z' })] },
      accounts: { 'user-1': [account({ balance: 10300 })] },
    });
    await rebuildForUser('user-1');
    expect(counters()).toEqual([{ id: 'acc-1', count: 3, last: '2026-04-09' }]);
    expect(balanceWrites()[0].UpdateExpression).toContain('#tradeCount = :count');
    expect(balanceWrites()[0].ConditionExpression).toBe('#updatedAt = :seen');
  });

  it('counts only live trades of the account that fall on a real day, and takes the day in the user time zone', async () => {
    ddbMock.on(GetCommand).resolves({ Item: { timeZone: 'Asia/Kolkata' } });
    stubWorld({
      trades: { 'user-1': [
        makeTrade({ openDate: '2026-04-06T20:30:00Z' }), // 2026-04-07 in Kolkata
        makeTrade({ tradeId: 'x', accountId: 'acc-2' }),
        makeTrade({ tradeId: 'y', accountId: '-1' }),
        makeTrade({ tradeId: 'z', openDate: 'garbage' }),
      ] },
      accounts: { 'user-1': [account({ balance: 10100 })] },
    });
    await rebuildForUser('user-1');
    expect(counters()).toEqual([{ id: 'acc-1', count: 1, last: '2026-04-07' }]);
  });

  it('an account without trades gets tradeCount 0 and no lastTradeDate (the attribute is removed)', async () => {
    stubWorld({ trades: { 'user-1': [] }, accounts: { 'user-1': [account({ tradeCount: 4, lastTradeDate: '2026-04-06' })] } });
    await rebuildForUser('user-1');
    const w = balanceWrites()[0];
    expect(w.ExpressionAttributeValues).toMatchObject({ ':count': 0 });
    expect(w.ExpressionAttributeValues).not.toHaveProperty(':lastDay');
    expect(w.UpdateExpression).toContain('REMOVE #lastTradeDate');
  });

  it('a wrong stored count or last day is corrected even when the balance is already right', async () => {
    stubWorld({ trades: { 'user-1': [makeTrade()] }, accounts: { 'user-1': [account({ balance: 10100, tradeCount: 9, lastTradeDate: '2026-01-01' })] } });
    await rebuildForUser('user-1');
    expect(counters()).toEqual([{ id: 'acc-1', count: 1, last: '2026-04-06' }]);
  });
});
