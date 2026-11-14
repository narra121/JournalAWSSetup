import { describe, expect, it } from 'vitest';
import { buildAdvancedStats } from '../../advanced-stats';
import { aggregateDailyRecords, computeDailyRecord } from '../../stats-aggregator';
import { SegmentsAggregator, SegmentsProcessor, rBucket, rSummary, realizedR } from '../processors/segments';

const trade = (o: Record<string, any> = {}) => ({
  userId: 'u', tradeId: `t${Math.random()}`, symbol: 'EURUSD', side: 'BUY', quantity: 1, entryPrice: 100, exitPrice: 110, stopLoss: 95,
  pnl: 10, openDate: '2026-11-09T10:15:00Z', closeDate: '2026-11-09T12:00:00Z', setupType: 'Breakout', tradingSession: 'London', assetClass: 'forex', ...o,
});

describe('realizedR (CONTRACT I2: from prices)', () => {
  it('is the price move over the stop distance; quantity, multiplier and P&L do not enter it', () => {
    expect(realizedR(trade() as any)).toBe(2); // (110 − 100) ÷ 5
    expect(realizedR(trade({ quantity: 2, contractMultiplier: 50, pnl: 1000 }) as any)).toBe(2);
    expect(realizedR(trade({ quantity: undefined, contractMultiplier: undefined, pnl: undefined }) as any)).toBe(2);
  });

  it('turns the sign for a SELL and goes below −1 for a loss beyond the stop', () => {
    expect(realizedR(trade({ side: 'SELL', entryPrice: 100, stopLoss: 104, exitPrice: 96 }) as any)).toBe(1);
    expect(realizedR(trade({ side: 'SELL', entryPrice: 100, stopLoss: 104, exitPrice: 108 }) as any)).toBe(-2);
    expect(realizedR(trade({ exitPrice: 94 }) as any)).toBeCloseTo(-1.2, 10);
  });

  it('is before fees: a price winner stays positive when fees made the P&L negative', () => {
    expect(realizedR(trade({ exitPrice: 101, pnl: -3, fees: 4 }) as any)).toBeCloseTo(0.2, 10);
  });

  it('is null without a usable stop, with the stop at the entry, or without a price or a side', () => {
    expect(realizedR(trade({ stopLoss: 0 }) as any)).toBeNull();
    expect(realizedR(trade({ stopLoss: null }) as any)).toBeNull();
    expect(realizedR(trade({ stopLoss: 100 }) as any)).toBeNull();
    expect(realizedR(trade({ exitPrice: null }) as any)).toBeNull();
    expect(realizedR(trade({ entryPrice: undefined }) as any)).toBeNull();
    expect(realizedR(trade({ side: undefined }) as any)).toBeNull();
  });

  it('keeps an exit at 0 (an option that expired worthless) as a real price', () => {
    expect(realizedR(trade({ entryPrice: 10, stopLoss: 5, exitPrice: 0 }) as any)).toBe(-2);
  });
});

describe('rSummary', () => {
  it('derives the average and the sample standard deviation from sums', () => {
    expect(rSummary({ rSum: 1.5, rSumSq: 5.25, rCount: 3 })).toEqual({ avgR: 0.5, sdR: 1.5, rCount: 3 }); // 2, −1, 0.5
  });

  it('is null without trades with an R, and has no spread for one trade', () => {
    expect(rSummary({ rSum: 0, rSumSq: 0, rCount: 0 })).toEqual({ avgR: null, sdR: null, rCount: 0 });
    expect(rSummary({ rSum: 2, rSumSq: 4, rCount: 1 })).toEqual({ avgR: 2, sdR: null, rCount: 1 });
  });

  it('never returns NaN when rounding makes the variance slightly negative', () => {
    expect(rSummary({ rSum: 3, rSumSq: 3 - 1e-12, rCount: 3 }).sdR).toBe(0);
  });

  it('buckets at the documented edges', () => {
    expect([-3, -2, -1.5, -1, 0, 0.5, 1, 2, 3, 3.01].map(rBucket)).toEqual(['<=-2', '<=-2', '-2..-1', '-2..-1', '-1..0', '0..1', '0..1', '1..2', '2..3', '>3']);
  });
});

describe('segments through the daily record and the aggregator', () => {
  const records = [
    computeDailyRecord('u', 'a1', '2026-11-09', [trade(), trade({ pnl: -5, exitPrice: 105, stopLoss: 105, setupType: 'Range', side: 'SELL' })]),
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

  it('counts a trade with a stop but no exit price neither as an R nor as "no stop"', () => {
    const rec: any = computeDailyRecord('u', 'a1', '2026-11-09', [trade({ exitPrice: null, pnl: null })]);
    expect(rec.rDistribution).toEqual({ buckets: {}, noStop: 0 });
    expect(rec.rCount).toBe(0);
  });
});

describe('account-level realised R across days (A-03)', () => {
  const d1: any = computeDailyRecord('u', 'a1', '2026-11-09', [trade(), trade({ side: 'SELL', stopLoss: 105, exitPrice: 105, pnl: -5 })]); // +2, −1
  const d2: any = computeDailyRecord('u', 'a1', '2026-11-10', [trade({ openDate: '2026-11-10T09:00:00Z', exitPrice: 102.5, quantity: undefined, contractMultiplier: undefined, pnl: undefined })]); // +0.5
  const d3: any = computeDailyRecord('u', 'a1', '2026-11-11', [trade({ openDate: '2026-11-11T09:00:00Z', stopLoss: null })]);

  it('each daily record carries the sum, the sum of squares and the count of R', () => {
    expect(d1).toMatchObject({ rSum: 1, rSumSq: 5, rCount: 2 });
    expect(d2).toMatchObject({ rSum: 0.5, rSumSq: 0.25, rCount: 1 });
    expect(d3).toMatchObject({ rSum: 0, rSumSq: 0, rCount: 0 });
  });

  it('the aggregate has the average R and its spread over every trade with an R, in any day order', () => {
    const stats: any = aggregateDailyRecords([d3, d2, d1], {});
    expect(stats.rCount).toBe(3);
    expect(stats.avgR).toBeCloseTo(0.5, 10);
    expect(stats.sdR).toBeCloseTo(1.5, 10); // sample SD of 2, −1, 0.5
  });

  it('a record stored before the R sums existed counts as no trade with an R', () => {
    const old = { ...d1 };
    delete old.rSum;
    delete old.rSumSq;
    delete old.rCount;
    expect(aggregateDailyRecords([old], {})).toMatchObject({ avgR: null, sdR: null, rCount: 0 });
    expect(aggregateDailyRecords([old, d2], {})).toMatchObject({ avgR: 0.5, sdR: null, rCount: 1 });
  });
});

describe('R per mistake and per broken rule, against trades without one (A-08)', () => {
  const rec: any = computeDailyRecord('u', 'a1', '2026-11-09', [
    trade({ mistakes: ['FOMO'], brokenRuleIds: ['r1'], exitPrice: 90, pnl: -10 }), // −2
    trade({ mistakes: ['FOMO', 'Late'], exitPrice: 105, pnl: 5 }), // +1
    trade({ mistakes: ['FOMO'], stopLoss: null, pnl: -20 }), // no R
    trade({ exitPrice: 102.5, pnl: 2.5 }), // +0.5, untagged
    trade({ mistakes: [], brokenRuleIds: [], exitPrice: 95, pnl: -5 }), // −1, untagged
  ]);
  const stats: any = aggregateDailyRecords([rec], {});

  it('gives each mistake its net P&L, the trades with an R and their average R', () => {
    expect(stats.mistakesDistribution.FOMO).toEqual({ count: 3, totalPnl: -25, rCount: 2, avgR: -0.5 });
    expect(stats.mistakesDistribution.Late).toEqual({ count: 1, totalPnl: 5, rCount: 1, avgR: 1 });
    expect(stats.noMistakeTrades).toEqual({ count: 2, totalPnl: -2.5, rCount: 2, avgR: -0.25 });
  });

  it('does the same for broken rules, with the trades that broke none as the baseline', () => {
    expect(stats.brokenRulesDistribution.r1).toEqual({ count: 1, totalPnl: -10, rCount: 1, avgR: -2 });
    expect(stats.noBrokenRuleTrades).toEqual({ count: 4, totalPnl: -17.5, rCount: 3, avgR: 0.5 / 3 });
    expect(stats.brokenRulesCounts).toEqual({ r1: 1 });
  });

  it('is null for a tag none of whose trades has an R, and for old records without the sums', () => {
    const old = { ...rec, mistakesDistribution: { FOMO: { count: 2, totalPnl: -30 } } };
    delete old.noMistakeTrades;
    const s: any = aggregateDailyRecords([old], {});
    expect(s.mistakesDistribution.FOMO).toEqual({ count: 2, totalPnl: -30, rCount: 0, avgR: null });
    expect(s.noMistakeTrades).toEqual({ count: 0, totalPnl: 0, rCount: 0, avgR: null });
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
