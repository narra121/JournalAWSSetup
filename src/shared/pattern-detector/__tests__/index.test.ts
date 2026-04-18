import { describe, it, expect } from 'vitest';
import { detectPatterns } from '../index.js';
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

/**
 * Generate N valid trades spread across multiple days/hours so that
 * hourlyEdges and dayOfWeekEdges are populated.
 */
function generateTrades(count: number): PatternTrade[] {
  const trades: PatternTrade[] = [];
  const baseDate = new Date('2026-03-01T09:00:00Z');

  for (let i = 0; i < count; i++) {
    const open = new Date(baseDate.getTime() + i * 24 * 60 * 60 * 1000); // one trade per day
    const close = new Date(open.getTime() + 30 * 60 * 1000); // 30min later
    trades.push(
      makeTrade({
        tradeId: `t${i + 1}`,
        openDate: open.toISOString(),
        closeDate: close.toISOString(),
        pnl: i % 3 === 0 ? -20 : 40, // mix of wins and losses
        symbol: i % 2 === 0 ? 'AAPL' : 'TSLA',
      }),
    );
  }
  return trades;
}

// ─── Tests ──────────────────────────────────────────────────────

describe('detectPatterns (orchestrator)', () => {
  it('returns a full PatternDetectionResult for 20 valid trades', () => {
    const trades = generateTrades(20);
    const result = detectPatterns(trades);

    // Structural checks
    expect(result.tradeCount).toBe(20);
    expect(result.dateRange.start).toBe('2026-03-01');
    expect(result.dateRange.end).toBe('2026-03-20');

    // All fields are defined
    expect(result.revengeTrades).toBeDefined();
    expect(result.overtradeDays).toBeDefined();
    expect(result.streaks).toBeDefined();
    expect(result.hourlyEdges).toBeDefined();
    expect(result.dayOfWeekEdges).toBeDefined();
    expect(result.costOfEmotion).toBeDefined();

    // hourlyEdges and dayOfWeekEdges should be non-empty for 20 trades across days
    expect(result.hourlyEdges.length).toBeGreaterThan(0);
    expect(result.dayOfWeekEdges.length).toBeGreaterThan(0);

    // longestWinStreak / longestLossStreak may or may not exist depending on
    // the generated data but should be structurally correct
    if (result.longestWinStreak) {
      expect(result.longestWinStreak.type).toBe('win');
      expect(result.longestWinStreak.length).toBeGreaterThanOrEqual(2);
    }
    if (result.longestLossStreak) {
      expect(result.longestLossStreak.type).toBe('loss');
      expect(result.longestLossStreak.length).toBeGreaterThanOrEqual(2);
    }
  });

  it('returns empty result for no trades', () => {
    const result = detectPatterns([]);

    expect(result.tradeCount).toBe(0);
    expect(result.dateRange).toEqual({ start: '', end: '' });
    expect(result.revengeTrades).toEqual([]);
    expect(result.overtradeDays).toEqual([]);
    expect(result.streaks).toEqual([]);
    expect(result.longestWinStreak).toBeNull();
    expect(result.longestLossStreak).toBeNull();
    expect(result.currentStreak).toBeNull();
    expect(result.hourlyEdges).toEqual([]);
    expect(result.dayOfWeekEdges).toEqual([]);
    expect(result.costOfEmotion).toEqual({
      revengeTrading: { count: 0, totalPnl: 0, avgPnl: 0 },
      overtrading: { daysCount: 0, excessTradePnl: 0 },
      rulesViolations: { count: 0, totalPnl: 0 },
      totalEmotionalCost: 0,
    });
  });

  it('detects revenge trades and overtrade days in an integrated scenario', () => {
    // Build a scenario with:
    //   - 5 "normal" days with 2 trades each (days 1-5)
    //   - 1 "overtrade" day with 6 trades (day 6)
    //   - 2 revenge trades on day 6 (loss followed by a trade within 5min)
    const trades: PatternTrade[] = [];

    // Days 1-5: 2 trades each, spread 2 hours apart (no revenge trigger)
    for (let day = 1; day <= 5; day++) {
      const dateStr = `2026-04-0${day}`;
      trades.push(
        makeTrade({
          tradeId: `normal-${day}-1`,
          openDate: `${dateStr}T09:30:00Z`,
          closeDate: `${dateStr}T10:00:00Z`,
          pnl: 50,
        }),
        makeTrade({
          tradeId: `normal-${day}-2`,
          openDate: `${dateStr}T12:00:00Z`,
          closeDate: `${dateStr}T12:30:00Z`,
          pnl: 30,
        }),
      );
    }

    // Day 6: 6 trades, including a revenge sequence
    const overtradeDate = '2026-04-06';
    trades.push(
      makeTrade({
        tradeId: 'ot-1',
        openDate: `${overtradeDate}T09:00:00Z`,
        closeDate: `${overtradeDate}T09:20:00Z`,
        pnl: 20,
      }),
      makeTrade({
        tradeId: 'ot-2',
        openDate: `${overtradeDate}T09:30:00Z`,
        closeDate: `${overtradeDate}T09:50:00Z`,
        pnl: 10,
      }),
      // Revenge trigger: loss followed by a trade within 5 minutes
      makeTrade({
        tradeId: 'ot-3-loss',
        openDate: `${overtradeDate}T10:00:00Z`,
        closeDate: `${overtradeDate}T10:15:00Z`,
        pnl: -100,
      }),
      makeTrade({
        tradeId: 'ot-4-revenge',
        openDate: `${overtradeDate}T10:18:00Z`, // 3 min after loss close
        closeDate: `${overtradeDate}T10:30:00Z`,
        pnl: -50,
      }),
      makeTrade({
        tradeId: 'ot-5',
        openDate: `${overtradeDate}T11:00:00Z`,
        closeDate: `${overtradeDate}T11:20:00Z`,
        pnl: 15,
      }),
      makeTrade({
        tradeId: 'ot-6',
        openDate: `${overtradeDate}T13:00:00Z`,
        closeDate: `${overtradeDate}T13:20:00Z`,
        pnl: 10,
      }),
    );

    const result = detectPatterns(trades);

    // Total 16 trades: 10 normal + 6 overtrade day
    expect(result.tradeCount).toBe(16);

    // Should detect revenge trade: ot-4-revenge triggered by ot-3-loss
    expect(result.revengeTrades.length).toBeGreaterThanOrEqual(1);
    const revengeSignal = result.revengeTrades.find(
      (r) => r.tradeId === 'ot-4-revenge',
    );
    expect(revengeSignal).toBeDefined();
    expect(revengeSignal!.triggerTradeId).toBe('ot-3-loss');
    expect(revengeSignal!.gapMinutes).toBe(3);

    // Should detect overtrade day: day 6 has 6 trades
    // Average trades per day = 16 / 6 days ~= 2.67
    // Threshold = 2.67 * 1.5 = 4.0 → day 6 (count=6) exceeds threshold
    expect(result.overtradeDays.length).toBeGreaterThanOrEqual(1);
    const otDay = result.overtradeDays.find((d) => d.date === '2026-04-06');
    expect(otDay).toBeDefined();
    expect(otDay!.tradeCount).toBe(6);

    // Date range should cover the full span
    expect(result.dateRange.start).toBe('2026-04-01');
    expect(result.dateRange.end).toBe('2026-04-06');

    // Cost of emotion should reflect the revenge trades
    expect(result.costOfEmotion.revengeTrading.count).toBeGreaterThanOrEqual(1);
  });

  it('does not mutate the original trades array', () => {
    const trades = generateTrades(10);
    const originalIds = trades.map((t) => t.tradeId);
    detectPatterns(trades);
    expect(trades.map((t) => t.tradeId)).toEqual(originalIds);
  });
});
