import { describe, it, expect } from 'vitest';
import { analyzeHourlyEdges, analyzeDayOfWeekEdges } from '../time-edges';
import { PatternTrade } from '../types';

function makeTrade(overrides: Partial<PatternTrade> & { tradeId: string; pnl: number; openDate: string }): PatternTrade {
  return {
    symbol: 'AAPL',
    accountId: 'acc1',
    closeDate: null,
    quantity: 1,
    entryPrice: 100,
    exitPrice: null,
    side: 'BUY',
    ...overrides,
  };
}

describe('analyzeHourlyEdges', () => {
  it('returns empty array for no trades', () => {
    const result = analyzeHourlyEdges([]);
    expect(result).toEqual([]);
  });

  it('labels green_zone when 3+ wins at same hour with positive avgPnl', () => {
    // All at UTC hour 14
    const trades = [
      makeTrade({ tradeId: 't1', pnl: 100, openDate: '2026-01-01T14:00:00Z' }),
      makeTrade({ tradeId: 't2', pnl: 200, openDate: '2026-01-02T14:30:00Z' }),
      makeTrade({ tradeId: 't3', pnl: 50, openDate: '2026-01-03T14:45:00Z' }),
    ];
    const result = analyzeHourlyEdges(trades);
    expect(result).toHaveLength(1);
    expect(result[0].hour).toBe(14);
    expect(result[0].tradeCount).toBe(3);
    expect(result[0].winRate).toBe(100);
    expect(result[0].label).toBe('green_zone');
    expect(result[0].totalPnl).toBe(350);
    expect(result[0].avgPnl).toBe(116.67);
  });

  it('labels red_zone when 3+ losses at same hour', () => {
    const trades = [
      makeTrade({ tradeId: 't1', pnl: -100, openDate: '2026-01-01T09:00:00Z' }),
      makeTrade({ tradeId: 't2', pnl: -200, openDate: '2026-01-02T09:30:00Z' }),
      makeTrade({ tradeId: 't3', pnl: -50, openDate: '2026-01-03T09:45:00Z' }),
    ];
    const result = analyzeHourlyEdges(trades);
    expect(result).toHaveLength(1);
    expect(result[0].hour).toBe(9);
    expect(result[0].winRate).toBe(0);
    expect(result[0].label).toBe('red_zone');
  });

  it('labels neutral when fewer than 3 trades', () => {
    const trades = [
      makeTrade({ tradeId: 't1', pnl: 100, openDate: '2026-01-01T10:00:00Z' }),
      makeTrade({ tradeId: 't2', pnl: 200, openDate: '2026-01-02T10:30:00Z' }),
    ];
    const result = analyzeHourlyEdges(trades);
    expect(result).toHaveLength(1);
    expect(result[0].label).toBe('neutral');
  });

  it('labels red_zone when avgPnl is negative even with decent winRate', () => {
    // 2 wins, 1 big loss -> winRate ~66.67% but avgPnl < 0
    const trades = [
      makeTrade({ tradeId: 't1', pnl: 10, openDate: '2026-01-01T11:00:00Z' }),
      makeTrade({ tradeId: 't2', pnl: 10, openDate: '2026-01-02T11:00:00Z' }),
      makeTrade({ tradeId: 't3', pnl: -100, openDate: '2026-01-03T11:00:00Z' }),
    ];
    const result = analyzeHourlyEdges(trades);
    expect(result[0].winRate).toBe(66.67);
    expect(result[0].avgPnl).toBe(-26.67);
    expect(result[0].label).toBe('red_zone');
  });

  it('only returns hours with trades', () => {
    const trades = [
      makeTrade({ tradeId: 't1', pnl: 10, openDate: '2026-01-01T08:00:00Z' }),
      makeTrade({ tradeId: 't2', pnl: 10, openDate: '2026-01-02T16:00:00Z' }),
    ];
    const result = analyzeHourlyEdges(trades);
    expect(result).toHaveLength(2);
    expect(result.map((r) => r.hour)).toEqual([8, 16]);
  });

  it('sorts results by hour', () => {
    const trades = [
      makeTrade({ tradeId: 't1', pnl: 10, openDate: '2026-01-01T20:00:00Z' }),
      makeTrade({ tradeId: 't2', pnl: 10, openDate: '2026-01-02T05:00:00Z' }),
      makeTrade({ tradeId: 't3', pnl: 10, openDate: '2026-01-03T12:00:00Z' }),
    ];
    const result = analyzeHourlyEdges(trades);
    expect(result.map((r) => r.hour)).toEqual([5, 12, 20]);
  });
});

describe('analyzeDayOfWeekEdges', () => {
  it('returns 7 entries for empty trades', () => {
    const result = analyzeDayOfWeekEdges([]);
    expect(result).toHaveLength(7);
    expect(result[0].dayName).toBe('Sun');
    expect(result[1].dayName).toBe('Mon');
    expect(result[6].dayName).toBe('Sat');
    result.forEach((entry) => {
      expect(entry.tradeCount).toBe(0);
      expect(entry.winRate).toBe(0);
      expect(entry.avgPnl).toBe(0);
      expect(entry.totalPnl).toBe(0);
      expect(entry.label).toBe('neutral');
    });
  });

  it('always returns exactly 7 entries', () => {
    const trades = [
      // 2026-01-05 is a Monday (day 1)
      makeTrade({ tradeId: 't1', pnl: 100, openDate: '2026-01-05T10:00:00Z' }),
    ];
    const result = analyzeDayOfWeekEdges(trades);
    expect(result).toHaveLength(7);
  });

  it('labels green_zone for a winning day with 3+ trades', () => {
    // 2026-01-05, 2026-01-12, 2026-01-19 are all Mondays (day 1)
    const trades = [
      makeTrade({ tradeId: 't1', pnl: 100, openDate: '2026-01-05T10:00:00Z' }),
      makeTrade({ tradeId: 't2', pnl: 200, openDate: '2026-01-12T10:00:00Z' }),
      makeTrade({ tradeId: 't3', pnl: 50, openDate: '2026-01-19T10:00:00Z' }),
    ];
    const result = analyzeDayOfWeekEdges(trades);
    const monday = result[1];
    expect(monday.dayName).toBe('Mon');
    expect(monday.tradeCount).toBe(3);
    expect(monday.winRate).toBe(100);
    expect(monday.label).toBe('green_zone');
    expect(monday.totalPnl).toBe(350);
  });

  it('labels red_zone for a losing day with 3+ trades', () => {
    // 2026-01-06, 2026-01-13, 2026-01-20 are all Tuesdays (day 2)
    const trades = [
      makeTrade({ tradeId: 't1', pnl: -100, openDate: '2026-01-06T10:00:00Z' }),
      makeTrade({ tradeId: 't2', pnl: -200, openDate: '2026-01-13T10:00:00Z' }),
      makeTrade({ tradeId: 't3', pnl: -50, openDate: '2026-01-20T10:00:00Z' }),
    ];
    const result = analyzeDayOfWeekEdges(trades);
    const tuesday = result[2];
    expect(tuesday.dayName).toBe('Tue');
    expect(tuesday.tradeCount).toBe(3);
    expect(tuesday.winRate).toBe(0);
    expect(tuesday.label).toBe('red_zone');
  });

  it('labels neutral for fewer than 3 trades on a day', () => {
    const trades = [
      makeTrade({ tradeId: 't1', pnl: 100, openDate: '2026-01-05T10:00:00Z' }),
      makeTrade({ tradeId: 't2', pnl: 200, openDate: '2026-01-12T10:00:00Z' }),
    ];
    const result = analyzeDayOfWeekEdges(trades);
    const monday = result[1];
    expect(monday.tradeCount).toBe(2);
    expect(monday.label).toBe('neutral');
  });

  it('rounds values to 2 decimal places', () => {
    // 3 trades on Monday, 2 wins 1 loss -> winRate = 66.67
    const trades = [
      makeTrade({ tradeId: 't1', pnl: 100, openDate: '2026-01-05T10:00:00Z' }),
      makeTrade({ tradeId: 't2', pnl: 50, openDate: '2026-01-12T10:00:00Z' }),
      makeTrade({ tradeId: 't3', pnl: -30, openDate: '2026-01-19T10:00:00Z' }),
    ];
    const result = analyzeDayOfWeekEdges(trades);
    const monday = result[1];
    expect(monday.winRate).toBe(66.67);
    expect(monday.avgPnl).toBe(40);
    expect(monday.totalPnl).toBe(120);
  });
});
