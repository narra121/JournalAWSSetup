import { describe, it, expect } from 'vitest';
import { detectOvertradeDays } from '../overtrading.js';
import type { PatternTrade } from '../types.js';

// ─── Helpers ────────────────────────────────────────────────────

function makeTrade(overrides: Partial<PatternTrade> & { tradeId: string }): PatternTrade {
  return {
    symbol: 'AAPL',
    accountId: 'acc1',
    openDate: '2026-04-10T09:30:00Z',
    closeDate: '2026-04-10T09:45:00Z',
    pnl: 0,
    quantity: 10,
    entryPrice: 150,
    exitPrice: 150,
    side: 'BUY',
    ...overrides,
  };
}

/** Generate N trades on a given date. */
function tradesOnDate(date: string, count: number, pnlEach: number = 10): PatternTrade[] {
  return Array.from({ length: count }, (_, i) =>
    makeTrade({
      tradeId: `${date}-t${i}`,
      openDate: `${date}T09:${String(30 + i).padStart(2, '0')}:00Z`,
      closeDate: `${date}T10:${String(i).padStart(2, '0')}:00Z`,
      pnl: pnlEach,
    }),
  );
}

// ─── Tests ──────────────────────────────────────────────────────

describe('detectOvertradeDays', () => {
  it('returns [] for empty array', () => {
    expect(detectOvertradeDays([])).toEqual([]);
  });

  it('returns [] when fewer than 5 trading days', () => {
    // 4 trading days, 10 trades each — still not enough days
    const trades = [
      ...tradesOnDate('2026-04-10', 10),
      ...tradesOnDate('2026-04-11', 2),
      ...tradesOnDate('2026-04-12', 2),
      ...tradesOnDate('2026-04-13', 2),
    ];
    expect(detectOvertradeDays(trades)).toEqual([]);
  });

  it('returns [] when exactly 5 days but no day exceeds 1.5x threshold', () => {
    // 5 days, 3 trades each → avg = 3, threshold = 4.5 → none exceed
    const trades = [
      ...tradesOnDate('2026-04-10', 3),
      ...tradesOnDate('2026-04-11', 3),
      ...tradesOnDate('2026-04-12', 3),
      ...tradesOnDate('2026-04-13', 3),
      ...tradesOnDate('2026-04-14', 3),
    ];
    expect(detectOvertradeDays(trades)).toEqual([]);
  });

  it('detects day with 1.5x+ average trade count', () => {
    // 5 days: 4 days with 2 trades, 1 day with 8 trades
    // total = 16, avg = 16/5 = 3.2, threshold = 4.8
    // Only day with 8 trades exceeds threshold
    const trades = [
      ...tradesOnDate('2026-04-10', 2, 50),
      ...tradesOnDate('2026-04-11', 2, -30),
      ...tradesOnDate('2026-04-12', 8, -10),  // overtrade day
      ...tradesOnDate('2026-04-13', 2, 20),
      ...tradesOnDate('2026-04-14', 2, 40),
    ];

    const result = detectOvertradeDays(trades);
    expect(result).toHaveLength(1);
    expect(result[0].date).toBe('2026-04-12');
    expect(result[0].tradeCount).toBe(8);
    expect(result[0].pnl).toBe(-80); // 8 * -10
    expect(result[0].avgTradesPerDay).toBe(3.2);
  });

  it('includes correct pnl and avgTradesPerDay', () => {
    // 5 days: 3,3,3,3,10 trades
    // total = 22, avg = 4.4, threshold = 6.6
    // Day with 10 trades (pnl = 5 each → 50 total) exceeds
    const trades = [
      ...tradesOnDate('2026-04-10', 3, 10),
      ...tradesOnDate('2026-04-11', 3, -5),
      ...tradesOnDate('2026-04-12', 3, 20),
      ...tradesOnDate('2026-04-13', 3, -10),
      ...tradesOnDate('2026-04-14', 10, 5),
    ];

    const result = detectOvertradeDays(trades);
    expect(result).toHaveLength(1);
    expect(result[0].date).toBe('2026-04-14');
    expect(result[0].tradeCount).toBe(10);
    expect(result[0].pnl).toBe(50);
    expect(result[0].avgTradesPerDay).toBe(4.4);
  });

  it('detects multiple overtrade days', () => {
    // 5 days: 1,1,1,8,8 trades
    // total = 19, avg = 3.8, threshold = 5.7
    // Two days with 8 trades each exceed
    const trades = [
      ...tradesOnDate('2026-04-10', 1),
      ...tradesOnDate('2026-04-11', 1),
      ...tradesOnDate('2026-04-12', 1),
      ...tradesOnDate('2026-04-13', 8, -20),
      ...tradesOnDate('2026-04-14', 8, 15),
    ];

    const result = detectOvertradeDays(trades);
    expect(result).toHaveLength(2);
    expect(result[0].date).toBe('2026-04-13');
    expect(result[1].date).toBe('2026-04-14');
  });

  it('returns results sorted by date ascending', () => {
    // Provide trades in mixed order
    const trades = [
      ...tradesOnDate('2026-04-14', 8),
      ...tradesOnDate('2026-04-10', 1),
      ...tradesOnDate('2026-04-13', 8),
      ...tradesOnDate('2026-04-11', 1),
      ...tradesOnDate('2026-04-12', 1),
    ];

    const result = detectOvertradeDays(trades);
    expect(result).toHaveLength(2);
    expect(result[0].date).toBe('2026-04-13');
    expect(result[1].date).toBe('2026-04-14');
  });

  it('uses openDate (not closeDate) for date grouping', () => {
    // Trade opens on 04-10 but closes on 04-11 — should count in 04-10
    const trades = [
      ...tradesOnDate('2026-04-10', 7),
      makeTrade({
        tradeId: 'overnight',
        openDate: '2026-04-10T15:50:00Z',
        closeDate: '2026-04-11T09:30:00Z', // closes next day
        pnl: -100,
      }),
      ...tradesOnDate('2026-04-11', 2),
      ...tradesOnDate('2026-04-12', 2),
      ...tradesOnDate('2026-04-13', 2),
      ...tradesOnDate('2026-04-14', 2),
    ];

    // Total: 8+2+2+2+2 = 16 trades across 5 days
    // avg = 3.2, threshold = 4.8
    // 04-10 has 8 trades → flagged
    const result = detectOvertradeDays(trades);
    expect(result).toHaveLength(1);
    expect(result[0].date).toBe('2026-04-10');
    expect(result[0].tradeCount).toBe(8);
  });

  it('handles exactly 5 trading days (minimum for detection)', () => {
    // 5 days: 2,2,2,2,10 → total=18, avg=3.6, threshold=5.4
    const trades = [
      ...tradesOnDate('2026-04-10', 2),
      ...tradesOnDate('2026-04-11', 2),
      ...tradesOnDate('2026-04-12', 2),
      ...tradesOnDate('2026-04-13', 2),
      ...tradesOnDate('2026-04-14', 10),
    ];

    const result = detectOvertradeDays(trades);
    expect(result).toHaveLength(1);
    expect(result[0].date).toBe('2026-04-14');
  });
});
