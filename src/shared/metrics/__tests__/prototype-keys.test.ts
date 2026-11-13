import { describe, expect, it } from 'vitest';
import { aggregateDailyRecords, computeDailyRecord } from '../../stats-aggregator';

const EVIL = ['__proto__', 'constructor', 'toString', 'hasOwnProperty'];

const trade = (o: Record<string, any> = {}) => ({
  userId: 'u', tradeId: `t${Math.random()}`, symbol: 'EURUSD', side: 'BUY', quantity: 1, entryPrice: 100, exitPrice: 110, stopLoss: 95,
  pnl: 10, openDate: '2026-11-09T10:15:00Z', closeDate: '2026-11-09T12:00:00Z', setupType: 'Breakout', tradingSession: 'London', ...o,
});

const own = (map: Record<string, any>, key: string) => Object.getOwnPropertyDescriptor(map, key)?.value;

describe('user text used as a map key (BE-007)', () => {
  it.each(EVIL)('"%s" as symbol, strategy, session, mistake, lesson, broken rule and asset class is a plain entry and never touches Object.prototype', (key) => {
    const t = trade({
      symbol: key, setupType: key, tradingSession: key, assetClass: key, mistakes: [key], lessons: [key], brokenRuleIds: [key],
    });
    const record: any = computeDailyRecord('u', 'acc', '2026-11-09', [t, { ...t, tradeId: 'second' }], null);

    expect(own(record.symbolDistribution, key)).toMatchObject({ count: 2, wins: 2, pnl: 20 });
    expect(own(record.strategyDistribution, key)).toMatchObject({ count: 2 });
    expect(own(record.sessionDistribution, key)).toMatchObject({ count: 2 });
    expect(own(record.mistakesDistribution, key)).toMatchObject({ count: 2, totalPnl: 20 });
    expect(own(record.lessonsDistribution, key)).toBe(2);
    expect(own(record.brokenRulesCounts, key)).toBe(2);
    expect(own(record.brokenRulesDistribution, key)).toMatchObject({ count: 2 });
    expect(own(record.segments.symbol, key)).toMatchObject({ trades: 2, wins: 2, net: 20 });
    expect(own(record.segments.assetClass, key)).toMatchObject({ trades: 2 });

    for (const probe of ['count', 'totalPnl', 'wins', 'pnl', 'trades', 'net']) {
      expect((Object.prototype as any)[probe]).toBeUndefined();
      expect(({} as any)[probe]).toBeUndefined();
    }
  });

  it('the aggregator merges those keys across days without polluting the prototype', () => {
    const days = ['2026-11-09', '2026-11-10'].map((d) =>
      computeDailyRecord('u', 'acc', d, [trade({ symbol: '__proto__', mistakes: ['__proto__'], lessons: ['constructor'], brokenRuleIds: ['__proto__'], assetClass: '__proto__' })], null)!);
    const stats: any = aggregateDailyRecords(days, {});

    expect(own(stats.symbolDistribution, '__proto__')).toMatchObject({ count: 2, pnl: 20 });
    expect(own(stats.mistakesDistribution, '__proto__')).toMatchObject({ count: 2 });
    expect(own(stats.lessonsDistribution, 'constructor')).toBe(2);
    expect(own(stats.brokenRulesCounts, '__proto__')).toBe(2);
    expect(own(stats.segments.symbol, '__proto__')).toMatchObject({ trades: 2 });
    expect(({} as any).count).toBeUndefined();
    expect(({} as any).totalPnl).toBeUndefined();
  });

  it('a user with key "__proto__" does not change another user\'s stats later in the same process', () => {
    computeDailyRecord('evil', 'acc', '2026-11-09', [trade({ symbol: '__proto__', mistakes: ['__proto__'] })], null);
    const other: any = computeDailyRecord('other', 'acc', '2026-11-09', [trade()], null);
    expect(Object.keys(other.symbolDistribution)).toEqual(['EURUSD']);
    expect(other.symbolDistribution.EURUSD).toMatchObject({ count: 1, pnl: 10 });
    expect(Object.keys(other.mistakesDistribution)).toEqual([]);
  });
});

describe('date-only trades in the weekday segment (BE-088)', () => {
  it('count for the weekday but not for the hour or the weekday x hour grid', () => {
    const rec: any = computeDailyRecord('u', 'acc', '2026-11-09', [trade({ openDate: '2026-11-09', closeDate: null })], null);
    expect(rec.segments.weekday['1']).toMatchObject({ trades: 1 }); // Monday
    expect(rec.segments.hour).toEqual({});
    expect(rec.segments.weekdayHour).toEqual({});
    const stats: any = aggregateDailyRecords([rec], {});
    expect(stats.dailyWinRate[1].trades).toBe(1);
    expect(stats.segments.weekday['1'].trades).toBe(1);
  });
});

describe('streaks and drawdown with several accounts on one day (BE-089)', () => {
  const day = (accountId: string, trades: Array<{ pnl: number; closeDate: string }>) =>
    computeDailyRecord('u', accountId, '2026-11-09', trades.map((t, i) => trade({ tradeId: `${accountId}${i}`, ...t })), null)!;

  it('are computed in time order across accounts, not account by account', () => {
    // A: 10:00 win, 15:00 loss. B: 12:00 loss. In time order: win, loss, loss.
    const a = day('A', [{ pnl: 10, closeDate: '2026-11-09T10:00:00Z' }, { pnl: -10, closeDate: '2026-11-09T15:00:00Z' }]);
    const b = day('B', [{ pnl: -5, closeDate: '2026-11-09T12:00:00Z' }]);
    const stats: any = aggregateDailyRecords([a, b], { totalCapital: 100 });
    expect(stats.consecutiveLosses).toBe(2);
    expect(stats.consecutiveWins).toBe(1);
    // equity 100 -> 110 (peak) -> 105 -> 95: drawdown 15 of 100
    expect(stats.maxDrawdown).toBeCloseTo(15, 5);
    // the old account-by-account order (win, loss, loss from A then B) would have given a drawdown of (110-95)/100 as well,
    // so check an order that differs: B's loss first
    const early = day('B', [{ pnl: -5, closeDate: '2026-11-09T09:00:00Z' }]);
    const s2: any = aggregateDailyRecords([a, early], { totalCapital: 100 });
    // time order: -5, +10, -10 -> equity 95, 105 (peak), 95: drawdown 10; consecutive losses 1
    expect(s2.consecutiveLosses).toBe(1);
    expect(s2.maxDrawdown).toBeCloseTo(10, 5);
  });

  it('keeps the merge order for records that carry no equity points', () => {
    const agg = aggregateDailyRecords([{ userId: 'u', sk: 'a#2026-11-09', accountId: 'a', date: '2026-11-09', pnlSequence: [1, -1, -1] } as any], {});
    expect(agg.consecutiveLosses).toBe(2);
  });
});

