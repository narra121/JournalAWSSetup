import { describe, it, expect } from 'vitest';
import { detectRevengeTrades } from '../revenge.js';
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

// ─── Tests ──────────────────────────────────────────────────────

describe('detectRevengeTrades', () => {
  it('returns [] for empty array', () => {
    expect(detectRevengeTrades([])).toEqual([]);
  });

  it('returns [] for a single trade', () => {
    const trades = [makeTrade({ tradeId: 't1', pnl: -50 })];
    expect(detectRevengeTrades(trades)).toEqual([]);
  });

  it('detects revenge trade opened within 15 minutes of a loss', () => {
    const trades: PatternTrade[] = [
      makeTrade({
        tradeId: 't1',
        openDate: '2026-04-10T09:30:00Z',
        closeDate: '2026-04-10T09:45:00Z',
        pnl: -100,
      }),
      makeTrade({
        tradeId: 't2',
        openDate: '2026-04-10T09:50:00Z',
        closeDate: '2026-04-10T10:05:00Z',
        pnl: -75,
      }),
    ];

    const signals = detectRevengeTrades(trades);
    expect(signals).toHaveLength(1);
    expect(signals[0]).toEqual({
      tradeId: 't2',
      triggerTradeId: 't1',
      gapMinutes: 5,
      triggerPnl: -100,
      revengePnl: -75,
    });
  });

  it('does NOT flag a trade after a win', () => {
    const trades: PatternTrade[] = [
      makeTrade({
        tradeId: 't1',
        openDate: '2026-04-10T09:30:00Z',
        closeDate: '2026-04-10T09:45:00Z',
        pnl: 200,  // win
      }),
      makeTrade({
        tradeId: 't2',
        openDate: '2026-04-10T09:50:00Z',
        closeDate: '2026-04-10T10:05:00Z',
        pnl: -50,
      }),
    ];

    expect(detectRevengeTrades(trades)).toEqual([]);
  });

  it('does NOT flag a trade after a breakeven (pnl = 0)', () => {
    const trades: PatternTrade[] = [
      makeTrade({
        tradeId: 't1',
        openDate: '2026-04-10T09:30:00Z',
        closeDate: '2026-04-10T09:45:00Z',
        pnl: 0,
      }),
      makeTrade({
        tradeId: 't2',
        openDate: '2026-04-10T09:50:00Z',
        closeDate: '2026-04-10T10:05:00Z',
        pnl: -50,
      }),
    ];

    expect(detectRevengeTrades(trades)).toEqual([]);
  });

  it('does NOT flag a trade with > 15 minute gap', () => {
    const trades: PatternTrade[] = [
      makeTrade({
        tradeId: 't1',
        openDate: '2026-04-10T09:30:00Z',
        closeDate: '2026-04-10T09:45:00Z',
        pnl: -100,
      }),
      makeTrade({
        tradeId: 't2',
        openDate: '2026-04-10T10:01:00Z', // 16 min after close
        closeDate: '2026-04-10T10:15:00Z',
        pnl: -50,
      }),
    ];

    expect(detectRevengeTrades(trades)).toEqual([]);
  });

  it('detects trade at exactly 15-minute boundary', () => {
    const trades: PatternTrade[] = [
      makeTrade({
        tradeId: 't1',
        openDate: '2026-04-10T09:30:00Z',
        closeDate: '2026-04-10T09:45:00Z',
        pnl: -100,
      }),
      makeTrade({
        tradeId: 't2',
        openDate: '2026-04-10T10:00:00Z', // exactly 15 min after close
        closeDate: '2026-04-10T10:15:00Z',
        pnl: -50,
      }),
    ];

    const signals = detectRevengeTrades(trades);
    expect(signals).toHaveLength(1);
    expect(signals[0].gapMinutes).toBe(15);
  });

  it('chains multiple revenge trades (loss -> revenge-loss -> revenge-loss)', () => {
    const trades: PatternTrade[] = [
      makeTrade({
        tradeId: 't1',
        openDate: '2026-04-10T09:30:00Z',
        closeDate: '2026-04-10T09:45:00Z',
        pnl: -100,
      }),
      makeTrade({
        tradeId: 't2',
        openDate: '2026-04-10T09:50:00Z',
        closeDate: '2026-04-10T10:00:00Z',
        pnl: -75,
      }),
      makeTrade({
        tradeId: 't3',
        openDate: '2026-04-10T10:10:00Z',
        closeDate: '2026-04-10T10:20:00Z',
        pnl: -30,
      }),
    ];

    const signals = detectRevengeTrades(trades);
    expect(signals).toHaveLength(2);

    expect(signals[0].tradeId).toBe('t2');
    expect(signals[0].triggerTradeId).toBe('t1');
    expect(signals[0].triggerPnl).toBe(-100);

    expect(signals[1].tradeId).toBe('t3');
    expect(signals[1].triggerTradeId).toBe('t2');
    expect(signals[1].triggerPnl).toBe(-75);
  });

  it('uses closeDate (not openDate) for gap calculation', () => {
    // Trade t1 opened at 09:30, closed at 10:00 (30 min trade duration)
    // Trade t2 opened at 10:10 — 10 min after close, 40 min after open
    // Should flag because gap from CLOSE is 10 min (< 15)
    const trades: PatternTrade[] = [
      makeTrade({
        tradeId: 't1',
        openDate: '2026-04-10T09:30:00Z',
        closeDate: '2026-04-10T10:00:00Z',
        pnl: -100,
      }),
      makeTrade({
        tradeId: 't2',
        openDate: '2026-04-10T10:10:00Z',
        closeDate: '2026-04-10T10:20:00Z',
        pnl: -50,
      }),
    ];

    const signals = detectRevengeTrades(trades);
    expect(signals).toHaveLength(1);
    expect(signals[0].gapMinutes).toBe(10);
  });

  it('falls back to openDate when closeDate is null', () => {
    // t1 has no closeDate; gap measured from t1.openDate
    const trades: PatternTrade[] = [
      makeTrade({
        tradeId: 't1',
        openDate: '2026-04-10T09:30:00Z',
        closeDate: null,
        pnl: -100,
      }),
      makeTrade({
        tradeId: 't2',
        openDate: '2026-04-10T09:40:00Z',
        closeDate: '2026-04-10T09:55:00Z',
        pnl: -50,
      }),
    ];

    const signals = detectRevengeTrades(trades);
    expect(signals).toHaveLength(1);
    expect(signals[0].gapMinutes).toBe(10);
  });

  it('sorts trades by openDate before checking', () => {
    // Provide trades in reverse order — detector should still work
    const trades: PatternTrade[] = [
      makeTrade({
        tradeId: 't2',
        openDate: '2026-04-10T09:50:00Z',
        closeDate: '2026-04-10T10:05:00Z',
        pnl: -75,
      }),
      makeTrade({
        tradeId: 't1',
        openDate: '2026-04-10T09:30:00Z',
        closeDate: '2026-04-10T09:45:00Z',
        pnl: -100,
      }),
    ];

    const signals = detectRevengeTrades(trades);
    expect(signals).toHaveLength(1);
    expect(signals[0].tradeId).toBe('t2');
    expect(signals[0].triggerTradeId).toBe('t1');
  });

  it('does not mutate the original trades array', () => {
    const trades: PatternTrade[] = [
      makeTrade({ tradeId: 't2', openDate: '2026-04-10T09:50:00Z', pnl: -50 }),
      makeTrade({ tradeId: 't1', openDate: '2026-04-10T09:30:00Z', pnl: -100 }),
    ];
    const originalOrder = trades.map(t => t.tradeId);
    detectRevengeTrades(trades);
    expect(trades.map(t => t.tradeId)).toEqual(originalOrder);
  });

  it('chain breaks when a winning trade intervenes', () => {
    const trades: PatternTrade[] = [
      makeTrade({
        tradeId: 't1',
        openDate: '2026-04-10T09:30:00Z',
        closeDate: '2026-04-10T09:45:00Z',
        pnl: -100,
      }),
      makeTrade({
        tradeId: 't2',
        openDate: '2026-04-10T09:50:00Z',
        closeDate: '2026-04-10T10:00:00Z',
        pnl: 200,  // win — breaks chain
      }),
      makeTrade({
        tradeId: 't3',
        openDate: '2026-04-10T10:05:00Z',
        closeDate: '2026-04-10T10:15:00Z',
        pnl: -30,
      }),
    ];

    const signals = detectRevengeTrades(trades);
    // t2 is revenge of t1, but t3 is NOT revenge because t2 was a win
    expect(signals).toHaveLength(1);
    expect(signals[0].tradeId).toBe('t2');
  });
});
