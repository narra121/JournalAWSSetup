import { describe, expect, it } from 'vitest';
import { buildAdvancedStats } from '../../advanced-stats';
import { aggregateDailyRecords, computeDailyRecord } from '../../stats-aggregator';
import { SegmentsAggregator, SegmentsProcessor, rBucket, realizedR } from '../processors/segments';

const trade = (o: Record<string, any> = {}) => ({
  userId: 'u', tradeId: `t${Math.random()}`, symbol: 'EURUSD', side: 'BUY', quantity: 1, entryPrice: 100, exitPrice: 110, stopLoss: 95,
  pnl: 10, openDate: '2026-11-09T10:15:00Z', closeDate: '2026-11-09T12:00:00Z', setupType: 'Breakout', tradingSession: 'London', assetClass: 'forex', ...o,
});

describe('realizedR', () => {
  it('is net P&L over the money risked at the stop (with the contract multiplier)', () => {
    expect(realizedR(trade() as any, 10)).toBe(2); // risk 5 × 1
    expect(realizedR(trade({ quantity: 2, contractMultiplier: 50 }) as any, 1000)).toBe(2); // risk 5 × 2 × 50 = 500
    expect(realizedR(trade({ side: 'SELL', entryPrice: 100, stopLoss: 104 }) as any, -4)).toBe(-1);
  });

  it('is null without a usable stop loss', () => {
    expect(realizedR(trade({ stopLoss: 0 }) as any, 10)).toBeNull();
    expect(realizedR(trade({ stopLoss: null }) as any, 10)).toBeNull();
    expect(realizedR(trade({ stopLoss: 100 }) as any, 10)).toBeNull();
  });

  it('buckets at the documented edges', () => {
    expect([-3, -2, -1.5, -1, 0, 0.5, 1, 2, 3, 3.01].map(rBucket)).toEqual(['<=-2', '<=-2', '-2..-1', '-2..-1', '-1..0', '0..1', '0..1', '1..2', '2..3', '>3']);
  });
});

describe('segments through the daily record and the aggregator', () => {
  const records = [
    computeDailyRecord('u', 'a1', '2026-11-09', [trade(), trade({ pnl: -5, exitPrice: 95, setupType: 'Range', side: 'SELL' })]),
    computeDailyRecord('u', 'a1', '2026-11-10', [trade({ openDate: '2026-11-10T14:00:00Z', closeDate: '2026-11-10T15:00:00Z', stopLoss: null, symbol: 'XAUUSD', assetClass: 'commodity' })]),
  ].filter(Boolean) as any[];
  const stats = aggregateDailyRecords(records, { totalCapital: 1000 });

  it('reports {trades, wins, net, avgR} for symbol, strategy, session, direction, asset class, weekday and hour', () => {
    const seg = (stats as any).segments;
    expect(seg.symbol.EURUSD).toEqual({ trades: 2, wins: 1, net: 5, avgR: 0.5 }); // R = +2 and -1
    expect(seg.symbol.XAUUSD).toEqual({ trades: 1, wins: 1, net: 10, avgR: null }); // no stop
    expect(seg.strategy.Breakout.trades).toBe(2);
    expect(seg.direction.SELL).toMatchObject({ trades: 1, wins: 0, net: -5 });
    expect(seg.assetClass.forex.trades).toBe(2);
    expect(seg.weekday['1'].trades).toBe(2); // Monday 2026-11-09
    expect(seg.hour['10'].trades).toBe(2);
    expect(seg.session.London.trades).toBe(3);
  });

  it('provides the weekday x hour grid', () => {
    expect((stats as any).weekdayHour).toEqual(expect.arrayContaining([
      { day: 1, hour: 10, trades: 2, wins: 1, net: 5 },
      { day: 2, hour: 14, trades: 1, wins: 1, net: 10 },
    ]));
  });

  it('builds the R histogram with all buckets and counts trades without a stop', () => {
    const r = (stats as any).rDistribution;
    expect(r.buckets.map((b: any) => b.label)).toEqual(['<=-2', '-2..-1', '-1..0', '0..1', '1..2', '2..3', '>3']);
    expect(r.buckets.find((b: any) => b.label === '1..2').count).toBe(1);
    expect(r.buckets.find((b: any) => b.label === '-2..-1').count).toBe(1);
    expect(r.noStop).toBe(1);
  });
});

describe('buildAdvancedStats', () => {
  const stats: any = {
    dailyPnl: [{ date: 'd1', pnl: 100, cumulativePnl: 100 }, { date: 'd2', pnl: -150, cumulativePnl: -50 }, { date: 'd3', pnl: 80, cumulativePnl: 30 }],
    rDistribution: { buckets: [{ label: '0..1', count: 2 }], noStop: 1 },
    segments: { strategy: { A: { trades: 4, wins: 2, net: 40, avgR: 0.5 }, B: { trades: 0, wins: 0, net: 0, avgR: null } } },
  };

  it('derives the drawdown curve from the equity curve (percent only with a starting capital)', () => {
    const withCapital = buildAdvancedStats(stats, 1000).drawdownCurve;
    expect(withCapital.map((p) => [p.equity, p.peak, p.drawdown])).toEqual([[1100, 1100, 0], [950, 1100, 150], [1030, 1100, 70]]);
    expect(withCapital[1].drawdownPct).toBeCloseTo(13.636, 2);
    expect(buildAdvancedStats(stats).drawdownCurve[1]).toMatchObject({ equity: -50, peak: 100, drawdown: 150 });
  });

  it('gives per-strategy expectancy and average R, and passes the histogram through', () => {
    const a = buildAdvancedStats(stats);
    expect(a.strategyExpectancy).toEqual({ A: { trades: 4, expectancy: 10, avgR: 0.5 }, B: { trades: 0, expectancy: 0, avgR: null } });
    expect(a.rDistribution.noStop).toBe(1);
  });
});

describe('processor reuse', () => {
  it('reset() clears every tally', () => {
    const p = new SegmentsProcessor();
    p.processTrade(trade() as any);
    p.reset();
    expect(p.getResult().segments.symbol).toEqual({});
    const a = new SegmentsAggregator();
    a.merge({ segments: { symbol: { X: { trades: 1, wins: 1, net: 1, rSum: 0, rCount: 0 } } } });
    a.reset();
    expect((a.getResult({}) as any).segments.symbol).toEqual({});
  });
});
