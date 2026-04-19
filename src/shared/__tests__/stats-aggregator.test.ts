import { describe, it, expect } from 'vitest';
import { computeDailyRecord, aggregateDailyRecords } from '../stats-aggregator.js';

// ---------------------------------------------------------------------------
// Helper: build a mock trade with sensible defaults
// ---------------------------------------------------------------------------
function makeTrade(overrides: Record<string, any> = {}) {
  return {
    userId: 'user1',
    tradeId: 'trade1',
    symbol: 'EURUSD',
    side: 'BUY',
    quantity: 1,
    openDate: '2026-04-10T10:00:00Z',
    closeDate: '2026-04-10T14:00:00Z',
    entryPrice: 1.1000,
    exitPrice: 1.1050,
    pnl: 50,
    riskRewardRatio: 2.0,
    outcome: 'TP',
    setupType: 'Breakout',
    tradingSession: 'London',
    accountId: 'acc1',
    ...overrides,
  };
}

// ===========================================================================
// computeDailyRecord
// ===========================================================================
describe('computeDailyRecord', () => {
  it('returns null for empty trades array', () => {
    const result = computeDailyRecord('user1', 'acc1', '2026-04-10', []);
    expect(result).toBeNull();
  });

  it('computes correct record for a single winning trade', () => {
    const trade = makeTrade();
    const record = computeDailyRecord('user1', 'acc1', '2026-04-10', [trade]);

    expect(record).not.toBeNull();
    // Core stats
    expect(record!.tradeCount).toBe(1);
    expect(record!.wins).toBe(1);
    expect(record!.losses).toBe(0);
    expect(record!.grossProfit).toBe(50);
    expect(record!.totalPnl).toBe(50);

    // Keys & identifiers
    expect(record!.sk).toBe('acc1#2026-04-10');
    expect(record!.date).toBe('2026-04-10');
    expect(record!.accountId).toBe('acc1');

    // Symbol distribution
    expect(record!.symbolDistribution).toBeDefined();
    expect(record!.symbolDistribution.EURUSD).toEqual(
      expect.objectContaining({ count: 1 }),
    );

    // PnL sequence
    expect(record!.pnlSequence).toEqual([50]);
  });

  it('computes correct record for multiple trades (2 wins, 1 loss)', () => {
    const trades = [
      makeTrade({ tradeId: 't1', pnl: 100 }),
      makeTrade({ tradeId: 't2', pnl: -30 }),
      makeTrade({ tradeId: 't3', pnl: 60 }),
    ];

    const record = computeDailyRecord('user1', 'acc1', '2026-04-10', trades);
    expect(record).not.toBeNull();

    expect(record!.tradeCount).toBe(3);
    expect(record!.wins).toBe(2);
    expect(record!.losses).toBe(1);
    expect(record!.grossProfit).toBe(160);
    expect(record!.grossLoss).toBe(30);
    expect(record!.bestTrade).toBe(100);
    expect(record!.worstTrade).toBe(-30);
  });

  it('sorts trades by closeDate for pnlSequence', () => {
    const trades = [
      makeTrade({ tradeId: 't1', pnl: 10, closeDate: '2026-04-10T16:00:00Z' }),
      makeTrade({ tradeId: 't2', pnl: 20, closeDate: '2026-04-10T12:00:00Z' }),
      makeTrade({ tradeId: 't3', pnl: 30, closeDate: '2026-04-10T08:00:00Z' }),
    ];

    const record = computeDailyRecord('user1', 'acc1', '2026-04-10', trades);
    // Chronological order: 08:00 → 12:00 → 16:00 → pnl [30, 20, 10]
    expect(record!.pnlSequence).toEqual([30, 20, 10]);
  });

  it('handles trades with no closeDate (uses openDate for sorting)', () => {
    const trades = [
      makeTrade({ tradeId: 't1', pnl: 5, closeDate: null, openDate: '2026-04-10T15:00:00Z' }),
      makeTrade({ tradeId: 't2', pnl: 10, closeDate: null, openDate: '2026-04-10T09:00:00Z' }),
    ];

    const record = computeDailyRecord('user1', 'acc1', '2026-04-10', trades);
    // Should sort by openDate when closeDate is absent: 09:00 → 15:00
    expect(record!.pnlSequence).toEqual([10, 5]);
  });

  it('sets dayOfWeek correctly (2026-04-10 is a Friday)', () => {
    const trade = makeTrade();
    const record = computeDailyRecord('user1', 'acc1', '2026-04-10', [trade]);
    // Friday = 5
    expect(record!.dayOfWeek).toBe(5);
  });

  it('computes duration stats when trades have both openDate and closeDate', () => {
    // 10:00 to 14:00 = 4 hours
    const trade = makeTrade({
      openDate: '2026-04-10T10:00:00Z',
      closeDate: '2026-04-10T14:00:00Z',
    });
    const record = computeDailyRecord('user1', 'acc1', '2026-04-10', [trade]);

    expect(record!.totalDurationHours).toBe(4);
    expect(record!.durationTradeCount).toBe(1);
    expect(record!.minDurationHours).toBe(4);
    expect(record!.maxDurationHours).toBe(4);
  });

  it('skips duration for trades without closeDate', () => {
    const trade = makeTrade({ closeDate: null });
    const record = computeDailyRecord('user1', 'acc1', '2026-04-10', [trade]);

    expect(record!.durationTradeCount).toBe(0);
    expect(record!.totalDurationHours).toBe(0);
  });

  it('populates hourly breakdown from openDate hour', () => {
    // openDate hour = 10 UTC
    const trade = makeTrade({ openDate: '2026-04-10T10:00:00Z' });
    const record = computeDailyRecord('user1', 'acc1', '2026-04-10', [trade]);

    expect(record!.hourlyBreakdown).toBeDefined();
    expect(record!.hourlyBreakdown['10']).toEqual(
      expect.objectContaining({ count: 1, wins: 1, pnl: 50 }),
    );
  });

  it('skips hourly breakdown for date-only openDate', () => {
    const trade = makeTrade({ openDate: '2026-04-10' });
    const record = computeDailyRecord('user1', 'acc1', '2026-04-10', [trade]);

    // HourlyProcessor returns only if openDate contains 'T'
    expect(record!.hourlyBreakdown).toEqual({});
  });

  it('computes a deterministic tradeHash from trades', () => {
    const trade1 = makeTrade({ tradeId: 'aaa', pnl: 50, updatedAt: '2026-04-10T14:00:00Z' });
    const trade2 = makeTrade({
      tradeId: 'bbb', pnl: -30, updatedAt: '2026-04-10T15:00:00Z',
      openDate: '2026-04-10T12:00:00Z', closeDate: '2026-04-10T15:00:00Z',
    });
    const record = computeDailyRecord('user1', 'acc1', '2026-04-10', [trade2, trade1]);

    expect(record).not.toBeNull();
    expect(record!.tradeHash).toBeDefined();
    expect(typeof record!.tradeHash).toBe('string');
    expect(record!.tradeHash!.length).toBe(64);

    const record2 = computeDailyRecord('user1', 'acc1', '2026-04-10', [trade1, trade2]);
    expect(record2!.tradeHash).toBe(record!.tradeHash);
  });

  it('produces different tradeHash when a trade pnl changes', () => {
    const trade = makeTrade({ tradeId: 'aaa', pnl: 50 });
    const record1 = computeDailyRecord('user1', 'acc1', '2026-04-10', [trade]);
    const tradeModified = { ...trade, pnl: 100 };
    const record2 = computeDailyRecord('user1', 'acc1', '2026-04-10', [tradeModified]);
    expect(record1!.tradeHash).not.toBe(record2!.tradeHash);
  });
});

// ===========================================================================
// aggregateDailyRecords
// ===========================================================================
describe('aggregateDailyRecords', () => {
  it('returns empty stats for empty array', () => {
    const stats = aggregateDailyRecords([]);

    expect(stats.totalTrades).toBe(0);
    expect(stats.wins).toBe(0);
    expect(stats.losses).toBe(0);
    expect(stats.totalPnl).toBe(0);
    expect(stats.grossProfit).toBe(0);
    expect(stats.grossLoss).toBe(0);
    expect(stats.dailyPnl).toEqual([]);
    expect(stats.symbolDistribution).toEqual({});

    // 24 hourly entries
    expect(stats.hourlyStats).toHaveLength(24);
    // 7 daily win rate entries
    expect(stats.dailyWinRate).toHaveLength(7);
  });

  it('aggregates a single daily record correctly', () => {
    const trade = makeTrade({ pnl: 50 });
    const record = computeDailyRecord('user1', 'acc1', '2026-04-10', [trade])!;
    const stats = aggregateDailyRecords([record]);

    expect(stats.totalTrades).toBe(1);
    expect(stats.wins).toBe(1);
    expect(stats.losses).toBe(0);
    expect(stats.totalPnl).toBe(50);
    expect(stats.grossProfit).toBe(50);
    expect(stats.bestTrade).toBe(50);
    expect(stats.worstTrade).toBe(50);
    expect(stats.winRate).toBe(100);
  });

  it('aggregates multiple days correctly (3 days)', () => {
    // Day 1: 2 wins ($100, $50)
    const day1 = computeDailyRecord('user1', 'acc1', '2026-04-07', [
      makeTrade({ tradeId: 't1', pnl: 100 }),
      makeTrade({ tradeId: 't2', pnl: 50 }),
    ])!;

    // Day 2: 1 loss (-$30)
    const day2 = computeDailyRecord('user1', 'acc1', '2026-04-08', [
      makeTrade({ tradeId: 't3', pnl: -30 }),
    ])!;

    // Day 3: 1 win ($80), 1 loss (-$20)
    const day3 = computeDailyRecord('user1', 'acc1', '2026-04-09', [
      makeTrade({ tradeId: 't4', pnl: 80 }),
      makeTrade({ tradeId: 't5', pnl: -20 }),
    ])!;

    const stats = aggregateDailyRecords([day1, day2, day3]);

    expect(stats.totalTrades).toBe(5);
    expect(stats.wins).toBe(3);
    expect(stats.losses).toBe(2);
    expect(stats.totalPnl).toBe(180);
    // profitFactor = grossProfit / grossLoss = 230 / 50 = 4.6
    expect(stats.profitFactor).toBeCloseTo(4.6, 5);
    // Consecutive wins: day1 has [100, 50], day2 has [-30], day3 has [80, -20]
    // Full sequence: 100, 50, -30, 80, -20 → max consecutive wins = 2 (the first two)
    expect(stats.consecutiveWins).toBe(2);
  });

  it('builds dailyPnl with cumulative across days', () => {
    const day1 = computeDailyRecord('user1', 'acc1', '2026-04-07', [
      makeTrade({ tradeId: 't1', pnl: 100 }),
    ])!;
    const day2 = computeDailyRecord('user1', 'acc1', '2026-04-08', [
      makeTrade({ tradeId: 't2', pnl: -30 }),
    ])!;
    const day3 = computeDailyRecord('user1', 'acc1', '2026-04-09', [
      makeTrade({ tradeId: 't3', pnl: 80 }),
    ])!;

    const stats = aggregateDailyRecords([day1, day2, day3]);

    expect(stats.dailyPnl).toEqual([
      { date: '2026-04-07', pnl: 100, cumulativePnl: 100 },
      { date: '2026-04-08', pnl: -30, cumulativePnl: 70 },
      { date: '2026-04-09', pnl: 80, cumulativePnl: 150 },
    ]);
  });

  it('merges symbol distributions across days', () => {
    const day1 = computeDailyRecord('user1', 'acc1', '2026-04-07', [
      makeTrade({ tradeId: 't1', symbol: 'EURUSD', pnl: 10 }),
      makeTrade({ tradeId: 't2', symbol: 'EURUSD', pnl: 20 }),
      makeTrade({ tradeId: 't3', symbol: 'EURUSD', pnl: 30 }),
    ])!;
    const day2 = computeDailyRecord('user1', 'acc1', '2026-04-08', [
      makeTrade({ tradeId: 't4', symbol: 'EURUSD', pnl: 40 }),
      makeTrade({ tradeId: 't5', symbol: 'EURUSD', pnl: 50 }),
      makeTrade({ tradeId: 't6', symbol: 'GBPJPY', pnl: 60 }),
    ])!;

    const stats = aggregateDailyRecords([day1, day2]);

    expect(stats.symbolDistribution.EURUSD.count).toBe(5);
    expect(stats.symbolDistribution.GBPJPY.count).toBe(1);
  });

  it('computes maxDrawdown with totalCapital', () => {
    // Create a sequence that generates a drawdown:
    // Trades: +100, +50, -80, -60, +30
    // With totalCapital=10000:
    //   equity: 10100, 10150 (peak), 10070, 10010, 10040
    //   drawdown from peak 10150: max = (10150-10010)/10000 * 100 = 1.4%
    const day1 = computeDailyRecord('user1', 'acc1', '2026-04-07', [
      makeTrade({ tradeId: 't1', pnl: 100, closeDate: '2026-04-07T10:00:00Z' }),
      makeTrade({ tradeId: 't2', pnl: 50, closeDate: '2026-04-07T11:00:00Z' }),
      makeTrade({ tradeId: 't3', pnl: -80, closeDate: '2026-04-07T12:00:00Z' }),
      makeTrade({ tradeId: 't4', pnl: -60, closeDate: '2026-04-07T13:00:00Z' }),
      makeTrade({ tradeId: 't5', pnl: 30, closeDate: '2026-04-07T14:00:00Z' }),
    ])!;

    const stats = aggregateDailyRecords([day1], { totalCapital: 10000 });

    // Peak equity = 10150, lowest after peak = 10010
    // maxDrawdown = (10150 - 10010) / 10000 * 100 = 1.4
    expect(stats.maxDrawdown).toBeCloseTo(1.4, 5);
  });

  it('computes maxDrawdown without totalCapital (equity curve method)', () => {
    // Trades: +100, -50, -80, +20
    // runningPnl after each: 100, 50, -30, -10
    // minRunningPnl = -30 → startingEquity = 30 + 1 = 31
    // equity: 31 → 131 (peak) → 81 → 1 → 21
    // drawdown from peak 131: (131 - 1) / 131 * 100 ≈ 99.24%
    const day1 = computeDailyRecord('user1', 'acc1', '2026-04-07', [
      makeTrade({ tradeId: 't1', pnl: 100, closeDate: '2026-04-07T10:00:00Z' }),
      makeTrade({ tradeId: 't2', pnl: -50, closeDate: '2026-04-07T11:00:00Z' }),
      makeTrade({ tradeId: 't3', pnl: -80, closeDate: '2026-04-07T12:00:00Z' }),
      makeTrade({ tradeId: 't4', pnl: 20, closeDate: '2026-04-07T13:00:00Z' }),
    ])!;

    const stats = aggregateDailyRecords([day1]);

    // startingEquity = 31, peak = 131, trough = 1
    // dd = (131 - 1) / 131 * 100 ≈ 99.236...
    expect(stats.maxDrawdown).toBeCloseTo((130 / 131) * 100, 5);
  });

  it('includes equityCurve when includeEquityCurve=true', () => {
    const trade = makeTrade({ pnl: 50 });
    const record = computeDailyRecord('user1', 'acc1', '2026-04-10', [trade])!;
    const stats = aggregateDailyRecords([record], { includeEquityCurve: true });

    expect(stats.equityCurve).toBeDefined();
    expect(stats.equityCurve!.length).toBeGreaterThan(0);
    expect(stats.equityCurve![0]).toEqual(
      expect.objectContaining({ pnl: 50, cumulativePnl: 50, symbol: 'EURUSD' }),
    );
  });

  it('omits equityCurve when includeEquityCurve=false (default)', () => {
    const trade = makeTrade({ pnl: 50 });
    const record = computeDailyRecord('user1', 'acc1', '2026-04-10', [trade])!;
    const stats = aggregateDailyRecords([record]);

    expect(stats.equityCurve).toBeUndefined();
  });

  it('groups dailyPnl by date when multiple accounts have same date', () => {
    const recordAcc1 = computeDailyRecord('user1', 'acc1', '2026-04-10', [
      makeTrade({ tradeId: 't1', pnl: 100, accountId: 'acc1' }),
    ])!;
    const recordAcc2 = computeDailyRecord('user1', 'acc2', '2026-04-10', [
      makeTrade({ tradeId: 't2', pnl: 70, accountId: 'acc2' }),
    ])!;

    const stats = aggregateDailyRecords([recordAcc1, recordAcc2]);

    // Should have ONE dailyPnl entry for 2026-04-10 with summed PnL
    expect(stats.dailyPnl).toHaveLength(1);
    expect(stats.dailyPnl[0]).toEqual({
      date: '2026-04-10',
      pnl: 170,
      cumulativePnl: 170,
    });
  });

  it('merges hourly stats across days', () => {
    // Both trades open at 10:00 UTC (hour 10)
    const day1 = computeDailyRecord('user1', 'acc1', '2026-04-07', [
      makeTrade({ tradeId: 't1', pnl: 40, openDate: '2026-04-07T10:00:00Z' }),
    ])!;
    const day2 = computeDailyRecord('user1', 'acc1', '2026-04-08', [
      makeTrade({ tradeId: 't2', pnl: 60, openDate: '2026-04-08T10:00:00Z' }),
    ])!;

    const stats = aggregateDailyRecords([day1, day2]);

    const hour10 = stats.hourlyStats.find(h => h.hour === '10');
    expect(hour10).toBeDefined();
    expect(hour10!.trades).toBe(2);
    expect(hour10!.wins).toBe(2);
    expect(hour10!.pnl).toBe(100);
    expect(hour10!.winRate).toBe(100);
  });

  it('computes dailyWinRate by day of week across multiple records', () => {
    // 2026-04-06 = Monday (dayOfWeek = 1)
    const monday = computeDailyRecord('user1', 'acc1', '2026-04-06', [
      makeTrade({ tradeId: 't1', pnl: 50 }),
      makeTrade({ tradeId: 't2', pnl: -20 }),
    ])!;

    // 2026-04-10 = Friday (dayOfWeek = 5)
    const friday = computeDailyRecord('user1', 'acc1', '2026-04-10', [
      makeTrade({ tradeId: 't3', pnl: 100 }),
    ])!;

    const stats = aggregateDailyRecords([monday, friday]);

    const monEntry = stats.dailyWinRate.find(d => d.day === 'Mon');
    expect(monEntry).toBeDefined();
    expect(monEntry!.trades).toBe(2);
    expect(monEntry!.wins).toBe(1);
    expect(monEntry!.winRate).toBe(50);

    const friEntry = stats.dailyWinRate.find(d => d.day === 'Fri');
    expect(friEntry).toBeDefined();
    expect(friEntry!.trades).toBe(1);
    expect(friEntry!.wins).toBe(1);
    expect(friEntry!.winRate).toBe(100);

    // Sunday should have 0 trades
    const sunEntry = stats.dailyWinRate.find(d => d.day === 'Sun');
    expect(sunEntry).toBeDefined();
    expect(sunEntry!.trades).toBe(0);
    expect(sunEntry!.winRate).toBe(0);
  });
});
