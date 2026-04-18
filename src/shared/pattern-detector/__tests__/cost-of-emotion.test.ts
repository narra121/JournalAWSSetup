import { describe, it, expect } from 'vitest';
import { calculateCostOfEmotion } from '../cost-of-emotion';
import { PatternTrade, RevengeTradeSignal, OvertradeDay } from '../types';

function makeTrade(overrides: Partial<PatternTrade> & { tradeId: string; pnl: number }): PatternTrade {
  return {
    symbol: 'AAPL',
    accountId: 'acc1',
    openDate: '2026-01-01T10:00:00Z',
    closeDate: null,
    quantity: 1,
    entryPrice: 100,
    exitPrice: null,
    side: 'BUY',
    ...overrides,
  };
}

describe('calculateCostOfEmotion', () => {
  it('returns zeros when no signals and no violations', () => {
    const trades = [
      makeTrade({ tradeId: 't1', pnl: 100 }),
      makeTrade({ tradeId: 't2', pnl: 200 }),
    ];
    const result = calculateCostOfEmotion(trades, [], []);
    expect(result.revengeTrading.count).toBe(0);
    expect(result.revengeTrading.totalPnl).toBe(0);
    expect(result.revengeTrading.avgPnl).toBe(0);
    expect(result.overtrading.daysCount).toBe(0);
    expect(result.overtrading.excessTradePnl).toBe(0);
    expect(result.rulesViolations.count).toBe(0);
    expect(result.rulesViolations.totalPnl).toBe(0);
    expect(result.totalEmotionalCost).toBe(0);
  });

  it('sums revenge trade pnl correctly', () => {
    const trades = [
      makeTrade({ tradeId: 't1', pnl: -50 }),
      makeTrade({ tradeId: 't2', pnl: -100 }),
      makeTrade({ tradeId: 't3', pnl: 200 }),
    ];
    const revengeSignals: RevengeTradeSignal[] = [
      { tradeId: 't1', triggerTradeId: 't0', gapMinutes: 5, triggerPnl: -200, revengePnl: -50 },
      { tradeId: 't2', triggerTradeId: 't0', gapMinutes: 3, triggerPnl: -200, revengePnl: -100 },
    ];
    const result = calculateCostOfEmotion(trades, revengeSignals, []);
    expect(result.revengeTrading.count).toBe(2);
    expect(result.revengeTrading.totalPnl).toBe(-150);
    expect(result.revengeTrading.avgPnl).toBe(-75);
  });

  it('sums rule violation pnl correctly', () => {
    const trades = [
      makeTrade({ tradeId: 't1', pnl: -80, brokenRules: ['no-fomo'] }),
      makeTrade({ tradeId: 't2', pnl: -120, brokenRules: ['stop-loss', 'position-size'] }),
      makeTrade({ tradeId: 't3', pnl: 300 }), // no violations
    ];
    const result = calculateCostOfEmotion(trades, [], []);
    expect(result.rulesViolations.count).toBe(2);
    expect(result.rulesViolations.totalPnl).toBe(-200);
  });

  it('ignores trades with empty brokenRules array', () => {
    const trades = [
      makeTrade({ tradeId: 't1', pnl: -50, brokenRules: [] }),
      makeTrade({ tradeId: 't2', pnl: -100, brokenRules: ['fomo'] }),
    ];
    const result = calculateCostOfEmotion(trades, [], []);
    expect(result.rulesViolations.count).toBe(1);
    expect(result.rulesViolations.totalPnl).toBe(-100);
  });

  it('sums overtrading pnl correctly', () => {
    const trades: PatternTrade[] = [];
    const overtradeDays: OvertradeDay[] = [
      { date: '2026-01-01', tradeCount: 15, pnl: -200, avgTradesPerDay: 5 },
      { date: '2026-01-02', tradeCount: 12, pnl: -150, avgTradesPerDay: 5 },
    ];
    const result = calculateCostOfEmotion(trades, [], overtradeDays);
    expect(result.overtrading.daysCount).toBe(2);
    expect(result.overtrading.excessTradePnl).toBe(-350);
  });

  it('computes totalEmotionalCost as sum of negative costs only', () => {
    const trades = [
      makeTrade({ tradeId: 't1', pnl: -50 }),
      makeTrade({ tradeId: 't2', pnl: -80, brokenRules: ['fomo'] }),
    ];
    const revengeSignals: RevengeTradeSignal[] = [
      { tradeId: 't1', triggerTradeId: 't0', gapMinutes: 5, triggerPnl: -200, revengePnl: -50 },
    ];
    const overtradeDays: OvertradeDay[] = [
      { date: '2026-01-01', tradeCount: 15, pnl: -100, avgTradesPerDay: 5 },
    ];
    const result = calculateCostOfEmotion(trades, revengeSignals, overtradeDays);
    // revenge: -50, overtrading: -100, rules: -80
    // totalEmotionalCost = min(0,-50) + min(0,-100) + min(0,-80) = -230
    expect(result.totalEmotionalCost).toBe(-230);
  });

  it('does not count positive pnl in totalEmotionalCost', () => {
    const trades = [
      makeTrade({ tradeId: 't1', pnl: 500 }), // revenge trade that was profitable
      makeTrade({ tradeId: 't2', pnl: 100, brokenRules: ['max-position'] }), // profitable violation
    ];
    const revengeSignals: RevengeTradeSignal[] = [
      { tradeId: 't1', triggerTradeId: 't0', gapMinutes: 5, triggerPnl: -200, revengePnl: 500 },
    ];
    const overtradeDays: OvertradeDay[] = [
      { date: '2026-01-01', tradeCount: 15, pnl: 200, avgTradesPerDay: 5 },
    ];
    const result = calculateCostOfEmotion(trades, revengeSignals, overtradeDays);
    // revenge totalPnl = 500 (positive), overtrading = 200 (positive), rules = 100 (positive)
    // min(0, 500) + min(0, 200) + min(0, 100) = 0
    expect(result.totalEmotionalCost).toBe(0);
  });

  it('rounds all values to 2 decimal places', () => {
    const trades = [
      makeTrade({ tradeId: 't1', pnl: -33.333 }),
      makeTrade({ tradeId: 't2', pnl: -66.666, brokenRules: ['rule1'] }),
    ];
    const revengeSignals: RevengeTradeSignal[] = [
      { tradeId: 't1', triggerTradeId: 't0', gapMinutes: 5, triggerPnl: -100, revengePnl: -33.333 },
    ];
    const result = calculateCostOfEmotion(trades, revengeSignals, []);
    expect(result.revengeTrading.totalPnl).toBe(-33.33);
    expect(result.revengeTrading.avgPnl).toBe(-33.33);
    expect(result.rulesViolations.totalPnl).toBe(-66.67);
  });

  it('handles mixed positive and negative across categories', () => {
    const trades = [
      makeTrade({ tradeId: 't1', pnl: 500 }), // profitable revenge trade
      makeTrade({ tradeId: 't2', pnl: -200, brokenRules: ['fomo'] }), // losing rule violation
    ];
    const revengeSignals: RevengeTradeSignal[] = [
      { tradeId: 't1', triggerTradeId: 't0', gapMinutes: 5, triggerPnl: -200, revengePnl: 500 },
    ];
    const overtradeDays: OvertradeDay[] = [
      { date: '2026-01-01', tradeCount: 15, pnl: -50, avgTradesPerDay: 5 },
    ];
    const result = calculateCostOfEmotion(trades, revengeSignals, overtradeDays);
    // revenge = 500 (positive, min(0,500)=0), overtrading = -50, rules = -200
    // totalEmotionalCost = 0 + (-50) + (-200) = -250
    expect(result.totalEmotionalCost).toBe(-250);
  });
});
