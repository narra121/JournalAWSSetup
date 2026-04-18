import { describe, it, expect } from 'vitest';
import { analyzeStreaks } from '../streaks';
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

describe('analyzeStreaks', () => {
  it('returns nulls for empty trades', () => {
    const result = analyzeStreaks([]);
    expect(result.streaks).toEqual([]);
    expect(result.longestWinStreak).toBeNull();
    expect(result.longestLossStreak).toBeNull();
    expect(result.currentStreak).toBeNull();
  });

  it('returns no streaks for a single trade', () => {
    const trades = [
      makeTrade({ tradeId: 't1', pnl: 100, openDate: '2026-01-01T10:00:00Z' }),
    ];
    const result = analyzeStreaks(trades);
    expect(result.streaks).toEqual([]);
    expect(result.longestWinStreak).toBeNull();
    expect(result.longestLossStreak).toBeNull();
    expect(result.currentStreak).toBeNull();
  });

  it('detects a win streak of length 3', () => {
    const trades = [
      makeTrade({ tradeId: 't1', pnl: 50, openDate: '2026-01-01T10:00:00Z' }),
      makeTrade({ tradeId: 't2', pnl: 30, openDate: '2026-01-02T10:00:00Z' }),
      makeTrade({ tradeId: 't3', pnl: 20, openDate: '2026-01-03T10:00:00Z' }),
    ];
    const result = analyzeStreaks(trades);
    expect(result.streaks).toHaveLength(1);
    expect(result.streaks[0].type).toBe('win');
    expect(result.streaks[0].length).toBe(3);
    expect(result.longestWinStreak?.length).toBe(3);
    expect(result.longestLossStreak).toBeNull();
  });

  it('detects a loss streak of length 2', () => {
    const trades = [
      makeTrade({ tradeId: 't1', pnl: -50, openDate: '2026-01-01T10:00:00Z' }),
      makeTrade({ tradeId: 't2', pnl: -30, openDate: '2026-01-02T10:00:00Z' }),
    ];
    const result = analyzeStreaks(trades);
    expect(result.streaks).toHaveLength(1);
    expect(result.streaks[0].type).toBe('loss');
    expect(result.streaks[0].length).toBe(2);
    expect(result.longestLossStreak?.length).toBe(2);
  });

  it('detects multiple streaks (win then loss then win)', () => {
    const trades = [
      makeTrade({ tradeId: 't1', pnl: 10, openDate: '2026-01-01T10:00:00Z' }),
      makeTrade({ tradeId: 't2', pnl: 20, openDate: '2026-01-02T10:00:00Z' }),
      makeTrade({ tradeId: 't3', pnl: -15, openDate: '2026-01-03T10:00:00Z' }),
      makeTrade({ tradeId: 't4', pnl: -25, openDate: '2026-01-04T10:00:00Z' }),
      makeTrade({ tradeId: 't5', pnl: -5, openDate: '2026-01-05T10:00:00Z' }),
      makeTrade({ tradeId: 't6', pnl: 40, openDate: '2026-01-06T10:00:00Z' }),
      makeTrade({ tradeId: 't7', pnl: 60, openDate: '2026-01-07T10:00:00Z' }),
    ];
    const result = analyzeStreaks(trades);
    expect(result.streaks).toHaveLength(3);
    expect(result.streaks[0].type).toBe('win');
    expect(result.streaks[0].length).toBe(2);
    expect(result.streaks[1].type).toBe('loss');
    expect(result.streaks[1].length).toBe(3);
    expect(result.streaks[2].type).toBe('win');
    expect(result.streaks[2].length).toBe(2);

    expect(result.longestWinStreak?.length).toBe(2);
    expect(result.longestLossStreak?.length).toBe(3);
  });

  it('sums PnL in streaks correctly', () => {
    const trades = [
      makeTrade({ tradeId: 't1', pnl: 100.5, openDate: '2026-01-01T10:00:00Z' }),
      makeTrade({ tradeId: 't2', pnl: 200.3, openDate: '2026-01-02T10:00:00Z' }),
      makeTrade({ tradeId: 't3', pnl: 50.2, openDate: '2026-01-03T10:00:00Z' }),
    ];
    const result = analyzeStreaks(trades);
    expect(result.streaks[0].totalPnl).toBe(351);
  });

  it('includes tradeIds in streaks', () => {
    const trades = [
      makeTrade({ tradeId: 'abc', pnl: 10, openDate: '2026-01-01T10:00:00Z' }),
      makeTrade({ tradeId: 'def', pnl: 20, openDate: '2026-01-02T10:00:00Z' }),
      makeTrade({ tradeId: 'ghi', pnl: 30, openDate: '2026-01-03T10:00:00Z' }),
    ];
    const result = analyzeStreaks(trades);
    expect(result.streaks[0].tradeIds).toEqual(['abc', 'def', 'ghi']);
  });

  it('tracks startDate and endDate correctly', () => {
    const trades = [
      makeTrade({ tradeId: 't1', pnl: 10, openDate: '2026-01-05T10:00:00Z' }),
      makeTrade({ tradeId: 't2', pnl: 20, openDate: '2026-01-10T10:00:00Z' }),
    ];
    const result = analyzeStreaks(trades);
    expect(result.streaks[0].startDate).toBe('2026-01-05T10:00:00Z');
    expect(result.streaks[0].endDate).toBe('2026-01-10T10:00:00Z');
  });

  it('tracks current streak when last run has length >= 2', () => {
    const trades = [
      makeTrade({ tradeId: 't1', pnl: -10, openDate: '2026-01-01T10:00:00Z' }),
      makeTrade({ tradeId: 't2', pnl: 50, openDate: '2026-01-02T10:00:00Z' }),
      makeTrade({ tradeId: 't3', pnl: 60, openDate: '2026-01-03T10:00:00Z' }),
      makeTrade({ tradeId: 't4', pnl: 70, openDate: '2026-01-04T10:00:00Z' }),
    ];
    const result = analyzeStreaks(trades);
    expect(result.currentStreak).not.toBeNull();
    expect(result.currentStreak?.type).toBe('win');
    expect(result.currentStreak?.length).toBe(3);
    expect(result.currentStreak?.tradeIds).toEqual(['t2', 't3', 't4']);
  });

  it('returns null currentStreak when last run has length 1', () => {
    const trades = [
      makeTrade({ tradeId: 't1', pnl: 50, openDate: '2026-01-01T10:00:00Z' }),
      makeTrade({ tradeId: 't2', pnl: 60, openDate: '2026-01-02T10:00:00Z' }),
      makeTrade({ tradeId: 't3', pnl: -10, openDate: '2026-01-03T10:00:00Z' }),
    ];
    const result = analyzeStreaks(trades);
    expect(result.currentStreak).toBeNull();
  });

  it('treats pnl of 0 as a win', () => {
    const trades = [
      makeTrade({ tradeId: 't1', pnl: 0, openDate: '2026-01-01T10:00:00Z' }),
      makeTrade({ tradeId: 't2', pnl: 50, openDate: '2026-01-02T10:00:00Z' }),
    ];
    const result = analyzeStreaks(trades);
    expect(result.streaks).toHaveLength(1);
    expect(result.streaks[0].type).toBe('win');
    expect(result.streaks[0].length).toBe(2);
  });

  it('sorts trades by openDate before analyzing', () => {
    const trades = [
      makeTrade({ tradeId: 't3', pnl: 30, openDate: '2026-01-03T10:00:00Z' }),
      makeTrade({ tradeId: 't1', pnl: 10, openDate: '2026-01-01T10:00:00Z' }),
      makeTrade({ tradeId: 't2', pnl: 20, openDate: '2026-01-02T10:00:00Z' }),
    ];
    const result = analyzeStreaks(trades);
    expect(result.streaks[0].tradeIds).toEqual(['t1', 't2', 't3']);
  });
});
