import { CoreStatsProcessor, CoreStatsAggregator } from '../processors/core-stats';
import { ExtremesProcessor, ExtremesAggregator } from '../processors/extremes';
import { RiskRewardProcessor, RiskRewardAggregator } from '../processors/risk-reward';
import { DurationProcessor, DurationAggregator } from '../processors/duration';
import { DistributionsProcessor, DistributionsAggregator } from '../processors/distributions';
import { HourlyProcessor, HourlyAggregator } from '../processors/hourly';
import { PnlSequenceProcessor, PnlSequenceAggregator } from '../processors/pnl-sequence';
import { DayOfWeekAggregator } from '../processors/day-of-week';
import { BrokenRulesProcessor, BrokenRulesAggregator } from '../processors/broken-rules';
import { MistakesProcessor, MistakesAggregator } from '../processors/mistakes';
import { LessonsProcessor, LessonsAggregator } from '../processors/lessons';
import type { TradeRecord, ProcessorContext } from '../types';

function makeTrade(overrides: Record<string, any> = {}): TradeRecord {
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
    riskRewardRatio: 2.5,
    outcome: 'TP',
    setupType: 'Breakout',
    tradingSession: 'London',
    accountId: 'acc1',
    ...overrides,
  } as TradeRecord;
}

const defaultContext: ProcessorContext = {
  date: '2026-04-10',
  accountId: 'acc1',
  userId: 'user1',
  tradeIndex: 0,
  totalTradesInDay: 1,
};

// ─── CoreStatsProcessor ──────────────────────────────────────────

describe('CoreStatsProcessor', () => {
  let proc: CoreStatsProcessor;

  beforeEach(() => {
    proc = new CoreStatsProcessor();
  });

  it('counts wins, losses, breakeven correctly', () => {
    proc.processTrade(makeTrade({ pnl: 50 }), defaultContext);
    proc.processTrade(makeTrade({ pnl: -30 }), defaultContext);
    proc.processTrade(makeTrade({ pnl: 0 }), defaultContext);

    const result = proc.getResult();
    expect(result.wins).toBe(1);
    expect(result.losses).toBe(1);
    expect(result.breakeven).toBe(1);
    expect(result.tradeCount).toBe(3);
  });

  it('calculates grossProfit and grossLoss', () => {
    proc.processTrade(makeTrade({ pnl: 100 }), defaultContext);
    proc.processTrade(makeTrade({ pnl: 50 }), defaultContext);
    proc.processTrade(makeTrade({ pnl: -30 }), defaultContext);

    const result = proc.getResult();
    expect(result.grossProfit).toBe(150);
    expect(result.grossLoss).toBe(30);
  });

  it('calculates totalPnl = grossProfit - grossLoss', () => {
    proc.processTrade(makeTrade({ pnl: 100 }), defaultContext);
    proc.processTrade(makeTrade({ pnl: -40 }), defaultContext);

    const result = proc.getResult();
    expect(result.totalPnl).toBe(60);
  });

  it('sums totalVolume', () => {
    proc.processTrade(makeTrade({ quantity: 5 }), defaultContext);
    proc.processTrade(makeTrade({ quantity: 3 }), defaultContext);

    const result = proc.getResult();
    expect(result.totalVolume).toBe(8);
  });

  it('reset clears all state', () => {
    proc.processTrade(makeTrade({ pnl: 100 }), defaultContext);
    proc.reset();

    const result = proc.getResult();
    expect(result.tradeCount).toBe(0);
    expect(result.wins).toBe(0);
    expect(result.losses).toBe(0);
    expect(result.breakeven).toBe(0);
    expect(result.grossProfit).toBe(0);
    expect(result.grossLoss).toBe(0);
    expect(result.totalPnl).toBe(0);
    expect(result.totalVolume).toBe(0);
  });
});

// ─── CoreStatsAggregator ─────────────────────────────────────────

describe('CoreStatsAggregator', () => {
  let agg: CoreStatsAggregator;

  beforeEach(() => {
    agg = new CoreStatsAggregator();
  });

  it('sums all fields across multiple daily records', () => {
    agg.merge({ tradeCount: 5, wins: 3, losses: 1, breakeven: 1, grossProfit: 300, grossLoss: 50, totalVolume: 10 });
    agg.merge({ tradeCount: 3, wins: 2, losses: 1, breakeven: 0, grossProfit: 200, grossLoss: 100, totalVolume: 6 });

    const result = agg.getResult({});
    expect(result.totalTrades).toBe(8);
    expect(result.wins).toBe(5);
    expect(result.losses).toBe(2);
    expect(result.breakeven).toBe(1);
    expect(result.grossProfit).toBe(500);
    expect(result.grossLoss).toBe(150);
    expect(result.totalVolume).toBe(16);
  });

  it('computes winRate, profitFactor, avgWin, avgLoss, expectancy', () => {
    agg.merge({ tradeCount: 4, wins: 2, losses: 2, breakeven: 0, grossProfit: 200, grossLoss: 100, totalVolume: 4 });

    const result = agg.getResult({});
    expect(result.winRate).toBe(50);
    expect(result.profitFactor).toBe(2);
    expect(result.avgWin).toBe(100);
    expect(result.avgLoss).toBe(50);
    expect(result.expectancy).toBe(25); // (200-100)/4
  });

  it('profitFactor returns null when no losses (profit exists)', () => {
    agg.merge({ tradeCount: 2, wins: 2, losses: 0, breakeven: 0, grossProfit: 100, grossLoss: 0, totalVolume: 2 });

    const result = agg.getResult({});
    expect(result.profitFactor).toBeNull();
  });

  it('profitFactor returns 0 when no profit and no loss', () => {
    agg.merge({ tradeCount: 1, wins: 0, losses: 0, breakeven: 1, grossProfit: 0, grossLoss: 0, totalVolume: 1 });

    const result = agg.getResult({});
    expect(result.profitFactor).toBe(0);
  });

  it('handles empty merge (all zeroes)', () => {
    const result = agg.getResult({});
    expect(result.totalTrades).toBe(0);
    expect(result.winRate).toBe(0);
    expect(result.profitFactor).toBe(0);
    expect(result.avgWin).toBe(0);
    expect(result.avgLoss).toBe(0);
    expect(result.expectancy).toBe(0);
  });
});

// ─── ExtremesProcessor ───────────────────────────────────────────

describe('ExtremesProcessor', () => {
  let proc: ExtremesProcessor;

  beforeEach(() => {
    proc = new ExtremesProcessor();
  });

  it('tracks best and worst trade', () => {
    proc.processTrade(makeTrade({ pnl: 100 }), defaultContext);
    proc.processTrade(makeTrade({ pnl: -50 }), defaultContext);
    proc.processTrade(makeTrade({ pnl: 30 }), defaultContext);

    const result = proc.getResult();
    expect(result.bestTrade).toBe(100);
    expect(result.worstTrade).toBe(-50);
  });

  it('returns 0 when no trades processed (after reset)', () => {
    proc.processTrade(makeTrade({ pnl: 100 }), defaultContext);
    proc.reset();

    const result = proc.getResult();
    expect(result.bestTrade).toBe(0);
    expect(result.worstTrade).toBe(0);
  });
});

// ─── ExtremesAggregator ──────────────────────────────────────────

describe('ExtremesAggregator', () => {
  let agg: ExtremesAggregator;

  beforeEach(() => {
    agg = new ExtremesAggregator();
  });

  it('takes max of bestTrade across records', () => {
    agg.merge({ bestTrade: 50, worstTrade: -10 });
    agg.merge({ bestTrade: 200, worstTrade: -5 });
    agg.merge({ bestTrade: 80, worstTrade: -30 });

    const result = agg.getResult({});
    expect(result.bestTrade).toBe(200);
  });

  it('takes min of worstTrade across records', () => {
    agg.merge({ bestTrade: 50, worstTrade: -10 });
    agg.merge({ bestTrade: 200, worstTrade: -5 });
    agg.merge({ bestTrade: 80, worstTrade: -30 });

    const result = agg.getResult({});
    expect(result.worstTrade).toBe(-30);
  });
});

// ─── RiskRewardProcessor ─────────────────────────────────────────

describe('RiskRewardProcessor', () => {
  let proc: RiskRewardProcessor;

  beforeEach(() => {
    proc = new RiskRewardProcessor();
  });

  it('sums R:R values and counts', () => {
    proc.processTrade(makeTrade({ riskRewardRatio: 2.0 }), defaultContext);
    proc.processTrade(makeTrade({ riskRewardRatio: 3.0 }), defaultContext);

    const result = proc.getResult();
    expect(result.sumRiskReward).toBe(5.0);
    expect(result.riskRewardCount).toBe(2);
  });

  it('skips null/undefined/negative/zero R:R values', () => {
    proc.processTrade(makeTrade({ riskRewardRatio: null }), defaultContext);
    proc.processTrade(makeTrade({ riskRewardRatio: undefined }), defaultContext);
    proc.processTrade(makeTrade({ riskRewardRatio: -1 }), defaultContext);
    proc.processTrade(makeTrade({ riskRewardRatio: 0 }), defaultContext);

    const result = proc.getResult();
    expect(result.sumRiskReward).toBe(0);
    expect(result.riskRewardCount).toBe(0);
  });

  it('skips non-finite R:R values', () => {
    proc.processTrade(makeTrade({ riskRewardRatio: Infinity }), defaultContext);
    proc.processTrade(makeTrade({ riskRewardRatio: NaN }), defaultContext);

    const result = proc.getResult();
    expect(result.sumRiskReward).toBe(0);
    expect(result.riskRewardCount).toBe(0);
  });
});

// ─── RiskRewardAggregator ────────────────────────────────────────

describe('RiskRewardAggregator', () => {
  let agg: RiskRewardAggregator;

  beforeEach(() => {
    agg = new RiskRewardAggregator();
  });

  it('computes avgRiskReward = sumRR / count', () => {
    agg.merge({ sumRiskReward: 6.0, riskRewardCount: 3 });
    agg.merge({ sumRiskReward: 4.0, riskRewardCount: 2 });

    const result = agg.getResult({});
    expect(result.avgRiskReward).toBe(2.0);
  });

  it('returns 0 when no R:R data', () => {
    const result = agg.getResult({});
    expect(result.avgRiskReward).toBe(0);
  });
});

// ─── DurationProcessor ───────────────────────────────────────────

describe('DurationProcessor', () => {
  let proc: DurationProcessor;

  beforeEach(() => {
    proc = new DurationProcessor();
  });

  it('calculates duration in hours from open/close dates', () => {
    proc.processTrade(makeTrade({
      openDate: '2026-04-10T10:00:00Z',
      closeDate: '2026-04-10T14:00:00Z',
    }), defaultContext);

    const result = proc.getResult();
    expect(result.totalDurationHours).toBe(4);
    expect(result.durationTradeCount).toBe(1);
  });

  it('tracks min/max duration', () => {
    proc.processTrade(makeTrade({
      openDate: '2026-04-10T10:00:00Z',
      closeDate: '2026-04-10T11:00:00Z',
    }), defaultContext);
    proc.processTrade(makeTrade({
      openDate: '2026-04-10T10:00:00Z',
      closeDate: '2026-04-10T18:00:00Z',
    }), defaultContext);

    const result = proc.getResult();
    expect(result.minDurationHours).toBe(1);
    expect(result.maxDurationHours).toBe(8);
  });

  it('skips trades without closeDate', () => {
    proc.processTrade(makeTrade({ closeDate: null }), defaultContext);
    proc.processTrade(makeTrade({ closeDate: undefined }), defaultContext);

    const result = proc.getResult();
    expect(result.durationTradeCount).toBe(0);
    expect(result.minDurationHours).toBe(0);
  });

  it('assigns trades to correct duration buckets', () => {
    // <1h: 30 min trade
    proc.processTrade(makeTrade({
      pnl: 10,
      openDate: '2026-04-10T10:00:00Z',
      closeDate: '2026-04-10T10:30:00Z',
    }), defaultContext);

    // 1-4h: 2h trade
    proc.processTrade(makeTrade({
      pnl: 20,
      openDate: '2026-04-10T10:00:00Z',
      closeDate: '2026-04-10T12:00:00Z',
    }), defaultContext);

    // 4-8h: 6h trade
    proc.processTrade(makeTrade({
      pnl: -10,
      openDate: '2026-04-10T10:00:00Z',
      closeDate: '2026-04-10T16:00:00Z',
    }), defaultContext);

    // 8-24h: 12h trade
    proc.processTrade(makeTrade({
      pnl: 30,
      openDate: '2026-04-10T10:00:00Z',
      closeDate: '2026-04-10T22:00:00Z',
    }), defaultContext);

    // >24h: 48h trade
    proc.processTrade(makeTrade({
      pnl: -5,
      openDate: '2026-04-10T10:00:00Z',
      closeDate: '2026-04-12T10:00:00Z',
    }), defaultContext);

    const result = proc.getResult();
    const buckets = result.durationBuckets;

    expect(buckets['<1h']).toEqual({ total: 1, wins: 1, losses: 0 });
    expect(buckets['1-4h']).toEqual({ total: 1, wins: 1, losses: 0 });
    expect(buckets['4-8h']).toEqual({ total: 1, wins: 0, losses: 1 });
    expect(buckets['8-24h']).toEqual({ total: 1, wins: 1, losses: 0 });
    expect(buckets['>24h']).toEqual({ total: 1, wins: 0, losses: 1 });
  });

  it('counts wins/losses per bucket', () => {
    // Two trades in same bucket: one win, one loss
    proc.processTrade(makeTrade({
      pnl: 50,
      openDate: '2026-04-10T10:00:00Z',
      closeDate: '2026-04-10T12:00:00Z',
    }), defaultContext);
    proc.processTrade(makeTrade({
      pnl: -30,
      openDate: '2026-04-10T10:00:00Z',
      closeDate: '2026-04-10T13:00:00Z',
    }), defaultContext);

    const result = proc.getResult();
    expect(result.durationBuckets['1-4h']).toEqual({ total: 2, wins: 1, losses: 1 });
  });
});

// ─── DurationAggregator ──────────────────────────────────────────

describe('DurationAggregator', () => {
  let agg: DurationAggregator;

  beforeEach(() => {
    agg = new DurationAggregator();
  });

  it('computes avgHoldingTime from totals', () => {
    agg.merge({ totalDurationHours: 10, durationTradeCount: 2, minDurationHours: 3, maxDurationHours: 7, durationBuckets: {} });
    agg.merge({ totalDurationHours: 6, durationTradeCount: 3, minDurationHours: 1, maxDurationHours: 4, durationBuckets: {} });

    const result = agg.getResult({});
    expect(result.avgHoldingTime).toBe(16 / 5);
  });

  it('takes min/max across records', () => {
    agg.merge({ totalDurationHours: 10, durationTradeCount: 2, minDurationHours: 3, maxDurationHours: 7, durationBuckets: {} });
    agg.merge({ totalDurationHours: 6, durationTradeCount: 3, minDurationHours: 1, maxDurationHours: 9, durationBuckets: {} });

    const result = agg.getResult({});
    expect(result.minDuration).toBe(1);
    expect(result.maxDuration).toBe(9);
  });

  it('merges bucket counts', () => {
    agg.merge({
      totalDurationHours: 4, durationTradeCount: 2, minDurationHours: 1, maxDurationHours: 3,
      durationBuckets: { '1-4h': { total: 2, wins: 1, losses: 1 } },
    });
    agg.merge({
      totalDurationHours: 2, durationTradeCount: 1, minDurationHours: 1, maxDurationHours: 2,
      durationBuckets: { '1-4h': { total: 1, wins: 1, losses: 0 }, '<1h': { total: 1, wins: 0, losses: 1 } },
    });

    const result = agg.getResult({});
    const map: Record<string, any> = {};
    for (const b of result.durationBuckets) map[b.range] = b;

    expect(map['1-4h'].total).toBe(3);
    expect(map['1-4h'].wins).toBe(2);
    expect(map['1-4h'].losses).toBe(1);
    expect(map['<1h'].total).toBe(1);
  });

  it('returns ordered bucket array', () => {
    agg.merge({
      totalDurationHours: 30, durationTradeCount: 3, minDurationHours: 0.5, maxDurationHours: 30,
      durationBuckets: {
        '>24h': { total: 1, wins: 1, losses: 0 },
        '<1h': { total: 1, wins: 0, losses: 1 },
        '4-8h': { total: 1, wins: 1, losses: 0 },
      },
    });

    const result = agg.getResult({});
    const ranges = result.durationBuckets.map((b: any) => b.range);
    expect(ranges).toEqual(['<1h', '4-8h', '>24h']);
  });
});

// ─── DistributionsProcessor ──────────────────────────────────────

describe('DistributionsProcessor', () => {
  let proc: DistributionsProcessor;

  beforeEach(() => {
    proc = new DistributionsProcessor();
  });

  it('counts per symbol, strategy, session, outcome', () => {
    proc.processTrade(makeTrade({ symbol: 'EURUSD', setupType: 'Breakout', tradingSession: 'London', outcome: 'TP' }), defaultContext);
    proc.processTrade(makeTrade({ symbol: 'GBPUSD', setupType: 'Reversal', tradingSession: 'NY', outcome: 'SL' }), defaultContext);

    const result = proc.getResult();
    expect(result.symbolDistribution['EURUSD'].count).toBe(1);
    expect(result.symbolDistribution['GBPUSD'].count).toBe(1);
    expect(result.strategyDistribution['Breakout'].count).toBe(1);
    expect(result.strategyDistribution['Reversal'].count).toBe(1);
    expect(result.sessionDistribution['London'].count).toBe(1);
    expect(result.sessionDistribution['NY'].count).toBe(1);
    expect(result.outcomeDistribution['TP']).toBe(1);
    expect(result.outcomeDistribution['SL']).toBe(1);
  });

  it('tracks wins and pnl per distribution key', () => {
    proc.processTrade(makeTrade({ symbol: 'EURUSD', pnl: 100 }), defaultContext);
    proc.processTrade(makeTrade({ symbol: 'EURUSD', pnl: -30 }), defaultContext);

    const result = proc.getResult();
    expect(result.symbolDistribution['EURUSD'].wins).toBe(1);
    expect(result.symbolDistribution['EURUSD'].pnl).toBe(70);
    expect(result.symbolDistribution['EURUSD'].count).toBe(2);
  });

  it("uses 'Unknown' for missing strategy/session", () => {
    proc.processTrade(makeTrade({ setupType: null, tradingSession: null }), defaultContext);

    const result = proc.getResult();
    expect(result.strategyDistribution['Unknown']).toBeDefined();
    expect(result.sessionDistribution['Unknown']).toBeDefined();
  });

  it("uses 'UNKNOWN' for missing outcome", () => {
    proc.processTrade(makeTrade({ outcome: null }), defaultContext);

    const result = proc.getResult();
    expect(result.outcomeDistribution['UNKNOWN']).toBe(1);
  });
});

// ─── DistributionsAggregator ─────────────────────────────────────

describe('DistributionsAggregator', () => {
  let agg: DistributionsAggregator;

  beforeEach(() => {
    agg = new DistributionsAggregator();
  });

  it('merges distribution maps by summing counts/wins/pnl', () => {
    agg.merge({
      symbolDistribution: { EURUSD: { count: 2, wins: 1, pnl: 50 } },
      strategyDistribution: { Breakout: { count: 1, wins: 1, pnl: 30 } },
      sessionDistribution: { London: { count: 1, wins: 0, pnl: -10 } },
      outcomeDistribution: { TP: 1, SL: 1 },
    });
    agg.merge({
      symbolDistribution: { EURUSD: { count: 3, wins: 2, pnl: 80 } },
      strategyDistribution: { Breakout: { count: 2, wins: 1, pnl: 20 }, Reversal: { count: 1, wins: 0, pnl: -5 } },
      sessionDistribution: { London: { count: 2, wins: 1, pnl: 40 } },
      outcomeDistribution: { TP: 2, SL: 1, BE: 1 },
    });

    const result = agg.getResult({});
    expect(result.symbolDistribution['EURUSD']).toEqual({ count: 5, wins: 3, pnl: 130 });
    expect(result.strategyDistribution['Breakout']).toEqual({ count: 3, wins: 2, pnl: 50 });
    expect(result.strategyDistribution['Reversal']).toEqual({ count: 1, wins: 0, pnl: -5 });
    expect(result.sessionDistribution['London']).toEqual({ count: 3, wins: 1, pnl: 30 });
    expect(result.outcomeDistribution['TP']).toBe(3);
    expect(result.outcomeDistribution['SL']).toBe(2);
    expect(result.outcomeDistribution['BE']).toBe(1);
  });
});

// ─── HourlyProcessor ────────────────────────────────────────────

describe('HourlyProcessor', () => {
  let proc: HourlyProcessor;

  beforeEach(() => {
    proc = new HourlyProcessor();
  });

  it('extracts hour from openDate ISO string', () => {
    proc.processTrade(makeTrade({ openDate: '2026-04-10T14:30:00Z', pnl: 50 }), defaultContext);

    const result = proc.getResult();
    expect(result.hourlyBreakdown['14']).toBeDefined();
    expect(result.hourlyBreakdown['14'].count).toBe(1);
    expect(result.hourlyBreakdown['14'].wins).toBe(1);
    expect(result.hourlyBreakdown['14'].pnl).toBe(50);
  });

  it("skips trades with date-only openDate (no 'T')", () => {
    proc.processTrade(makeTrade({ openDate: '2026-04-10' }), defaultContext);

    const result = proc.getResult();
    expect(Object.keys(result.hourlyBreakdown).length).toBe(0);
  });

  it('tracks count, wins, pnl per hour', () => {
    proc.processTrade(makeTrade({ openDate: '2026-04-10T09:00:00Z', pnl: 100 }), defaultContext);
    proc.processTrade(makeTrade({ openDate: '2026-04-10T09:30:00Z', pnl: -20 }), defaultContext);
    proc.processTrade(makeTrade({ openDate: '2026-04-10T09:45:00Z', pnl: 30 }), defaultContext);

    const result = proc.getResult();
    expect(result.hourlyBreakdown['9'].count).toBe(3);
    expect(result.hourlyBreakdown['9'].wins).toBe(2);
    expect(result.hourlyBreakdown['9'].pnl).toBe(110);
  });
});

// ─── HourlyAggregator ───────────────────────────────────────────

describe('HourlyAggregator', () => {
  let agg: HourlyAggregator;

  beforeEach(() => {
    agg = new HourlyAggregator();
  });

  it('returns 24 entries (one per hour)', () => {
    const result = agg.getResult({});
    expect(result.hourlyStats.length).toBe(24);
  });

  it('computes winRate per hour', () => {
    agg.merge({
      hourlyBreakdown: { '9': { count: 4, wins: 3, pnl: 100 } },
    });

    const result = agg.getResult({});
    const hour9 = result.hourlyStats.find((h: any) => h.hour === '09');
    expect(hour9).toBeDefined();
    expect(hour9!.winRate).toBe(75);
    expect(hour9!.trades).toBe(4);
    expect(hour9!.pnl).toBe(100);
  });

  it('hours with no data have zero values', () => {
    agg.merge({
      hourlyBreakdown: { '10': { count: 1, wins: 1, pnl: 50 } },
    });

    const result = agg.getResult({});
    const hour0 = result.hourlyStats.find((h: any) => h.hour === '00');
    expect(hour0).toBeDefined();
    expect(hour0!.trades).toBe(0);
    expect(hour0!.wins).toBe(0);
    expect(hour0!.pnl).toBe(0);
    expect(hour0!.winRate).toBe(0);
  });

  it('hour format is zero-padded ("00", "09", "23")', () => {
    agg.merge({
      hourlyBreakdown: {
        '0': { count: 1, wins: 0, pnl: -10 },
        '9': { count: 1, wins: 1, pnl: 10 },
        '23': { count: 1, wins: 1, pnl: 20 },
      },
    });

    const result = agg.getResult({});
    const hours = result.hourlyStats.map((h: any) => h.hour);
    expect(hours[0]).toBe('00');
    expect(hours[9]).toBe('09');
    expect(hours[23]).toBe('23');
  });
});

// ─── PnlSequenceProcessor ───────────────────────────────────────

describe('PnlSequenceProcessor', () => {
  let proc: PnlSequenceProcessor;

  beforeEach(() => {
    proc = new PnlSequenceProcessor();
  });

  it('collects ordered pnl values', () => {
    proc.processTrade(makeTrade({ pnl: 50 }), defaultContext);
    proc.processTrade(makeTrade({ pnl: -30 }), defaultContext);
    proc.processTrade(makeTrade({ pnl: 10 }), defaultContext);

    const result = proc.getResult();
    expect(result.pnlSequence).toEqual([50, -30, 10]);
  });

  it('collects equity curve points with dateTime and symbol', () => {
    proc.processTrade(makeTrade({
      pnl: 50,
      symbol: 'EURUSD',
      closeDate: '2026-04-10T14:00:00Z',
    }), defaultContext);

    const result = proc.getResult();
    expect(result.equityCurvePoints.length).toBe(1);
    expect(result.equityCurvePoints[0].pnl).toBe(50);
    expect(result.equityCurvePoints[0].symbol).toBe('EURUSD');
    expect(result.equityCurvePoints[0].dateTime).toBe('2026-04-10T14:00:00Z');
  });
});

// ─── PnlSequenceAggregator ──────────────────────────────────────

describe('PnlSequenceAggregator', () => {
  let agg: PnlSequenceAggregator;

  beforeEach(() => {
    agg = new PnlSequenceAggregator();
  });

  it('computes consecutiveWins (longest win streak)', () => {
    agg.merge({
      pnlSequence: [10, 20, 30, -10, 5],
      equityCurvePoints: [],
      date: '2026-04-10',
      totalPnl: 55,
    });

    const result = agg.getResult({});
    expect(result.consecutiveWins).toBe(3);
  });

  it('computes consecutiveLosses (longest loss streak)', () => {
    agg.merge({
      pnlSequence: [10, -5, -10, -15, 20],
      equityCurvePoints: [],
      date: '2026-04-10',
      totalPnl: 0,
    });

    const result = agg.getResult({});
    expect(result.consecutiveLosses).toBe(3);
  });

  it('computes maxDrawdown with totalCapital', () => {
    // Start at 1000, go +100 to 1100 (peak), then -300 to 800
    // dd = (1100-800)/1000 * 100 = 30%
    agg.merge({
      pnlSequence: [100, -300],
      equityCurvePoints: [],
      date: '2026-04-10',
      totalPnl: -200,
    });

    const result = agg.getResult({ totalCapital: 1000 });
    expect(result.maxDrawdown).toBe(30);
  });

  it('computes maxDrawdown without totalCapital (equity curve method)', () => {
    // pnlValues: [100, -50]
    // runningPnl goes: 100, 50 -> minRunningPnl stays 0
    // startingEquity = 0 + 1 = 1
    // After +100: equity=101, peak=101
    // After -50: equity=51, dd = (101-51)/101 * 100 ~ 49.5%
    agg.merge({
      pnlSequence: [100, -50],
      equityCurvePoints: [],
      date: '2026-04-10',
      totalPnl: 50,
    });

    const result = agg.getResult({});
    expect(result.maxDrawdown).toBeCloseTo(49.50, 1);
  });

  it('computes sharpeRatio', () => {
    // pnl values: [10, 10, 10, 10] -> avg=10, stdDev=0 -> sharpe=0
    agg.merge({
      pnlSequence: [10, 10, 10, 10],
      equityCurvePoints: [],
      date: '2026-04-10',
      totalPnl: 40,
    });

    const result = agg.getResult({});
    expect(result.sharpeRatio).toBe(0);

    // Now test with variance
    agg.reset();
    // [10, -5]: avg=2.5, variance = ((10-2.5)^2 + (-5-2.5)^2)/2 = (56.25+56.25)/2 = 56.25
    // stdDev = 7.5, sharpe = 2.5/7.5 = 0.333...
    agg.merge({
      pnlSequence: [10, -5],
      equityCurvePoints: [],
      date: '2026-04-10',
      totalPnl: 5,
    });

    const result2 = agg.getResult({});
    expect(result2.sharpeRatio).toBeCloseTo(1 / 3, 4);
  });

  it('builds dailyPnl with cumulative sums', () => {
    agg.merge({
      pnlSequence: [50],
      equityCurvePoints: [],
      date: '2026-04-10',
      totalPnl: 50,
    });
    agg.merge({
      pnlSequence: [30],
      equityCurvePoints: [],
      date: '2026-04-11',
      totalPnl: 30,
    });

    const result = agg.getResult({});
    expect(result.dailyPnl).toEqual([
      { date: '2026-04-10', pnl: 50, cumulativePnl: 50 },
      { date: '2026-04-11', pnl: 30, cumulativePnl: 80 },
    ]);
  });

  it('builds equityCurve when includeEquityCurve=true', () => {
    agg.merge({
      pnlSequence: [50, -20],
      equityCurvePoints: [
        { pnl: 50, symbol: 'EURUSD', dateTime: '2026-04-10T10:00:00Z' },
        { pnl: -20, symbol: 'GBPUSD', dateTime: '2026-04-10T14:00:00Z' },
      ],
      date: '2026-04-10',
      totalPnl: 30,
    });

    const result = agg.getResult({ includeEquityCurve: true });
    expect(result.equityCurve).toBeDefined();
    expect(result.equityCurve.length).toBe(2);
    expect(result.equityCurve[0].cumulativePnl).toBe(50);
    expect(result.equityCurve[1].cumulativePnl).toBe(30);
    expect(result.equityCurve[0].symbol).toBe('EURUSD');
  });

  it('omits equityCurve when includeEquityCurve=false', () => {
    agg.merge({
      pnlSequence: [50],
      equityCurvePoints: [
        { pnl: 50, symbol: 'EURUSD', dateTime: '2026-04-10T10:00:00Z' },
      ],
      date: '2026-04-10',
      totalPnl: 50,
    });

    const result = agg.getResult({ includeEquityCurve: false });
    expect(result.equityCurve).toBeUndefined();
  });

  it('handles breakeven trades (pnl=0) not breaking streaks', () => {
    // Sequence: win, win, breakeven, win -> streak of 3 (breakeven doesn't reset)
    // then loss -> streak broken
    agg.merge({
      pnlSequence: [10, 20, 0, 30, -5],
      equityCurvePoints: [],
      date: '2026-04-10',
      totalPnl: 55,
    });

    const result = agg.getResult({});
    expect(result.consecutiveWins).toBe(3);
    // The 0 doesn't break the win streak, but only 2 wins before it count,
    // then after 0 there's 1 more win = continuation not counted as part of streak
    // Actually looking at the code: pnl>0 increments curWins; pnl=0 does nothing
    // So: 10 -> curWins=1, 20 -> curWins=2, 0 -> nothing, 30 -> curWins=3, -5 -> curWins=0
    // maxWins = 3
    expect(result.consecutiveWins).toBe(3);
  });
});

// ─── DayOfWeekAggregator ─────────────────────────────────────────

describe('DayOfWeekAggregator', () => {
  let agg: DayOfWeekAggregator;

  beforeEach(() => {
    agg = new DayOfWeekAggregator();
  });

  it('returns 7 entries (Sun-Sat)', () => {
    const result = agg.getResult({});
    expect(result.dailyWinRate.length).toBe(7);
    expect(result.dailyWinRate[0].day).toBe('Sun');
    expect(result.dailyWinRate[6].day).toBe('Sat');
  });

  it('accumulates trades/wins/pnl by day of week', () => {
    // dayOfWeek=1 is Monday
    agg.merge({ dayOfWeek: 1, tradeCount: 3, wins: 2, totalPnl: 100 });
    agg.merge({ dayOfWeek: 1, tradeCount: 2, wins: 1, totalPnl: -50 });

    const result = agg.getResult({});
    const monday = result.dailyWinRate.find((d: any) => d.day === 'Mon');
    expect(monday).toBeDefined();
    expect(monday!.trades).toBe(5);
    expect(monday!.wins).toBe(3);
    expect(monday!.pnl).toBe(50);
  });

  it('computes winRate per day', () => {
    agg.merge({ dayOfWeek: 5, tradeCount: 10, wins: 7, totalPnl: 200 });

    const result = agg.getResult({});
    const friday = result.dailyWinRate.find((d: any) => d.day === 'Fri');
    expect(friday).toBeDefined();
    expect(friday!.winRate).toBe(70);
  });
});

// ─── BrokenRulesProcessor ──────────────────────────────────────

describe('BrokenRulesProcessor', () => {
  let proc: BrokenRulesProcessor;

  beforeEach(() => {
    proc = new BrokenRulesProcessor();
  });

  it('returns empty counts when trade has no brokenRuleIds', () => {
    proc.processTrade(makeTrade({}), defaultContext);

    const result = proc.getResult();
    expect(result.brokenRulesCounts).toEqual({});
  });

  it('counts each broken rule from brokenRuleIds', () => {
    proc.processTrade(makeTrade({ brokenRuleIds: ['r1', 'r2'] }), defaultContext);

    const result = proc.getResult();
    expect(result.brokenRulesCounts).toEqual({ r1: 1, r2: 1 });
  });

  it('sums counts across multiple trades with overlapping rule IDs', () => {
    proc.processTrade(makeTrade({ brokenRuleIds: ['r1', 'r2'] }), defaultContext);
    proc.processTrade(makeTrade({ brokenRuleIds: ['r2', 'r3'] }), defaultContext);
    proc.processTrade(makeTrade({ brokenRuleIds: ['r1'] }), defaultContext);

    const result = proc.getResult();
    expect(result.brokenRulesCounts).toEqual({ r1: 2, r2: 2, r3: 1 });
  });

  it('returns empty counts when brokenRuleIds is an empty array', () => {
    proc.processTrade(makeTrade({ brokenRuleIds: [] }), defaultContext);

    const result = proc.getResult();
    expect(result.brokenRulesCounts).toEqual({});
  });

  it('returns empty counts when brokenRuleIds is null', () => {
    proc.processTrade(makeTrade({ brokenRuleIds: null }), defaultContext);

    const result = proc.getResult();
    expect(result.brokenRulesCounts).toEqual({});
  });

  it('returns empty counts when brokenRuleIds is a non-array value', () => {
    proc.processTrade(makeTrade({ brokenRuleIds: 'r1' }), defaultContext);

    const result = proc.getResult();
    expect(result.brokenRulesCounts).toEqual({});
  });

  it('resets state correctly', () => {
    proc.processTrade(makeTrade({ brokenRuleIds: ['r1', 'r2'] }), defaultContext);
    expect(proc.getResult().brokenRulesCounts).toEqual({ r1: 1, r2: 1 });

    proc.reset();

    const result = proc.getResult();
    expect(result.brokenRulesCounts).toEqual({});
  });
});

// ─── BrokenRulesAggregator ─────────────────────────────────────

describe('BrokenRulesAggregator', () => {
  let agg: BrokenRulesAggregator;

  beforeEach(() => {
    agg = new BrokenRulesAggregator();
  });

  it('merges counts from multiple daily records', () => {
    agg.merge({ brokenRulesCounts: { r1: 2, r2: 1 } });
    agg.merge({ brokenRulesCounts: { r1: 3, r3: 4 } });

    const result = agg.getResult({});
    expect(result.brokenRulesCounts).toEqual({ r1: 5, r2: 1, r3: 4 });
  });

  it('handles records with missing brokenRulesCounts (treated as empty)', () => {
    agg.merge({ brokenRulesCounts: { r1: 1 } });
    agg.merge({}); // no brokenRulesCounts
    agg.merge({ brokenRulesCounts: undefined });

    const result = agg.getResult({});
    expect(result.brokenRulesCounts).toEqual({ r1: 1 });
  });

  it('passes through a single record unchanged', () => {
    agg.merge({ brokenRulesCounts: { r5: 7, r6: 3 } });

    const result = agg.getResult({});
    expect(result.brokenRulesCounts).toEqual({ r5: 7, r6: 3 });
  });

  it('returns empty counts when no records are merged', () => {
    const result = agg.getResult({});
    expect(result.brokenRulesCounts).toEqual({});
  });

  it('merges multiple records with different ruleIds', () => {
    agg.merge({ brokenRulesCounts: { r1: 1 } });
    agg.merge({ brokenRulesCounts: { r2: 2 } });
    agg.merge({ brokenRulesCounts: { r3: 3 } });

    const result = agg.getResult({});
    expect(result.brokenRulesCounts).toEqual({ r1: 1, r2: 2, r3: 3 });
  });
});

// ─── BrokenRulesProcessor (brokenRulesDistribution with PnL) ──

describe('BrokenRulesProcessor — brokenRulesDistribution', () => {
  let proc: BrokenRulesProcessor;

  beforeEach(() => {
    proc = new BrokenRulesProcessor();
  });

  it('brokenRulesDistribution includes count AND totalPnl per ruleId', () => {
    proc.processTrade(makeTrade({ brokenRuleIds: ['r1', 'r2'], pnl: 50 }), defaultContext);

    const result = proc.getResult();
    expect(result.brokenRulesDistribution).toEqual({
      r1: { count: 1, totalPnl: 50 },
      r2: { count: 1, totalPnl: 50 },
    });
  });

  it('accumulates totalPnl from calcPnL across multiple trades', () => {
    proc.processTrade(makeTrade({ brokenRuleIds: ['r1'], pnl: 100 }), defaultContext);
    proc.processTrade(makeTrade({ brokenRuleIds: ['r1'], pnl: -40 }), defaultContext);
    proc.processTrade(makeTrade({ brokenRuleIds: ['r1', 'r2'], pnl: 20 }), defaultContext);

    const result = proc.getResult();
    expect(result.brokenRulesDistribution['r1']).toEqual({ count: 3, totalPnl: 80 });
    expect(result.brokenRulesDistribution['r2']).toEqual({ count: 1, totalPnl: 20 });
  });

  it('returns both brokenRulesCounts and brokenRulesDistribution (backward compat)', () => {
    proc.processTrade(makeTrade({ brokenRuleIds: ['r1', 'r2'], pnl: 30 }), defaultContext);

    const result = proc.getResult();
    // Legacy field
    expect(result.brokenRulesCounts).toEqual({ r1: 1, r2: 1 });
    // New field
    expect(result.brokenRulesDistribution).toEqual({
      r1: { count: 1, totalPnl: 30 },
      r2: { count: 1, totalPnl: 30 },
    });
  });

  it('returns empty distribution when no brokenRuleIds', () => {
    proc.processTrade(makeTrade({}), defaultContext);

    const result = proc.getResult();
    expect(result.brokenRulesDistribution).toEqual({});
  });

  it('reset clears both brokenRulesCounts and brokenRulesDistribution', () => {
    proc.processTrade(makeTrade({ brokenRuleIds: ['r1'], pnl: 50 }), defaultContext);
    proc.reset();

    const result = proc.getResult();
    expect(result.brokenRulesCounts).toEqual({});
    expect(result.brokenRulesDistribution).toEqual({});
  });
});

// ─── BrokenRulesAggregator (brokenRulesDistribution merging) ──

describe('BrokenRulesAggregator — brokenRulesDistribution', () => {
  let agg: BrokenRulesAggregator;

  beforeEach(() => {
    agg = new BrokenRulesAggregator();
  });

  it('merges brokenRulesDistribution from multiple daily records', () => {
    agg.merge({
      brokenRulesCounts: { r1: 2 },
      brokenRulesDistribution: { r1: { count: 2, totalPnl: 80 } },
    });
    agg.merge({
      brokenRulesCounts: { r1: 1, r2: 1 },
      brokenRulesDistribution: { r1: { count: 1, totalPnl: -30 }, r2: { count: 1, totalPnl: 50 } },
    });

    const result = agg.getResult({});
    expect(result.brokenRulesDistribution).toEqual({
      r1: { count: 3, totalPnl: 50 },
      r2: { count: 1, totalPnl: 50 },
    });
    // backward compat
    expect(result.brokenRulesCounts).toEqual({ r1: 3, r2: 1 });
  });

  it('handles records with no brokenRulesDistribution', () => {
    agg.merge({ brokenRulesCounts: { r1: 1 } });
    agg.merge({});

    const result = agg.getResult({});
    expect(result.brokenRulesDistribution).toEqual({});
    expect(result.brokenRulesCounts).toEqual({ r1: 1 });
  });
});

// ─── MistakesProcessor ─────────────────────────────────────────

describe('MistakesProcessor', () => {
  let proc: MistakesProcessor;

  beforeEach(() => {
    proc = new MistakesProcessor();
  });

  it('returns empty mistakesDistribution when trade has no mistakes', () => {
    proc.processTrade(makeTrade({}), defaultContext);

    const result = proc.getResult();
    expect(result.mistakesDistribution).toEqual({});
  });

  it('accumulates count and totalPnl per mistake string', () => {
    proc.processTrade(makeTrade({ mistakes: ['Chased entry'], pnl: -50 }), defaultContext);

    const result = proc.getResult();
    expect(result.mistakesDistribution['Chased entry']).toEqual({ count: 1, totalPnl: -50 });
  });

  it('handles multiple trades with overlapping mistakes (sums correctly)', () => {
    proc.processTrade(makeTrade({ mistakes: ['Chased entry', 'No stop loss'], pnl: -40 }), defaultContext);
    proc.processTrade(makeTrade({ mistakes: ['Chased entry', 'Oversize'], pnl: 20 }), defaultContext);
    proc.processTrade(makeTrade({ mistakes: ['No stop loss'], pnl: -10 }), defaultContext);

    const result = proc.getResult();
    expect(result.mistakesDistribution['Chased entry']).toEqual({ count: 2, totalPnl: -20 });
    expect(result.mistakesDistribution['No stop loss']).toEqual({ count: 2, totalPnl: -50 });
    expect(result.mistakesDistribution['Oversize']).toEqual({ count: 1, totalPnl: 20 });
  });

  it('handles empty array mistakes field', () => {
    proc.processTrade(makeTrade({ mistakes: [] }), defaultContext);

    const result = proc.getResult();
    expect(result.mistakesDistribution).toEqual({});
  });

  it('handles null mistakes field', () => {
    proc.processTrade(makeTrade({ mistakes: null }), defaultContext);

    const result = proc.getResult();
    expect(result.mistakesDistribution).toEqual({});
  });

  it('handles non-array mistakes field (string)', () => {
    proc.processTrade(makeTrade({ mistakes: 'Chased entry' }), defaultContext);

    const result = proc.getResult();
    expect(result.mistakesDistribution).toEqual({});
  });

  it('reset clears state', () => {
    proc.processTrade(makeTrade({ mistakes: ['Chased entry'], pnl: 100 }), defaultContext);
    expect(Object.keys(proc.getResult().mistakesDistribution).length).toBe(1);

    proc.reset();

    const result = proc.getResult();
    expect(result.mistakesDistribution).toEqual({});
  });
});

// ─── MistakesAggregator ────────────────────────────────────────

describe('MistakesAggregator', () => {
  let agg: MistakesAggregator;

  beforeEach(() => {
    agg = new MistakesAggregator();
  });

  it('merges mistakesDistribution from multiple daily records', () => {
    agg.merge({
      mistakesDistribution: {
        'Chased entry': { count: 2, totalPnl: -80 },
        'Oversize': { count: 1, totalPnl: -20 },
      },
    });
    agg.merge({
      mistakesDistribution: {
        'Chased entry': { count: 1, totalPnl: 30 },
        'No stop loss': { count: 3, totalPnl: -150 },
      },
    });

    const result = agg.getResult({});
    expect(result.mistakesDistribution['Chased entry']).toEqual({ count: 3, totalPnl: -50 });
    expect(result.mistakesDistribution['Oversize']).toEqual({ count: 1, totalPnl: -20 });
    expect(result.mistakesDistribution['No stop loss']).toEqual({ count: 3, totalPnl: -150 });
  });

  it('handles records with no mistakesDistribution', () => {
    agg.merge({ mistakesDistribution: { 'Chased entry': { count: 1, totalPnl: -10 } } });
    agg.merge({});
    agg.merge({ mistakesDistribution: undefined });

    const result = agg.getResult({});
    expect(result.mistakesDistribution['Chased entry']).toEqual({ count: 1, totalPnl: -10 });
  });

  it('returns empty distribution when no records are merged', () => {
    const result = agg.getResult({});
    expect(result.mistakesDistribution).toEqual({});
  });
});

// ─── LessonsProcessor ──────────────────────────────────────────

describe('LessonsProcessor', () => {
  let proc: LessonsProcessor;

  beforeEach(() => {
    proc = new LessonsProcessor();
  });

  it('returns empty lessonsDistribution when trade has no lessons', () => {
    proc.processTrade(makeTrade({}), defaultContext);

    const result = proc.getResult();
    expect(result.lessonsDistribution).toEqual({});
  });

  it('counts each lesson string', () => {
    proc.processTrade(makeTrade({ lessons: ['Wait for confirmation'] }), defaultContext);

    const result = proc.getResult();
    expect(result.lessonsDistribution['Wait for confirmation']).toBe(1);
  });

  it('handles multiple trades with overlapping lessons', () => {
    proc.processTrade(makeTrade({ lessons: ['Wait for confirmation', 'Use smaller size'] }), defaultContext);
    proc.processTrade(makeTrade({ lessons: ['Wait for confirmation', 'Follow the plan'] }), defaultContext);
    proc.processTrade(makeTrade({ lessons: ['Use smaller size'] }), defaultContext);

    const result = proc.getResult();
    expect(result.lessonsDistribution['Wait for confirmation']).toBe(2);
    expect(result.lessonsDistribution['Use smaller size']).toBe(2);
    expect(result.lessonsDistribution['Follow the plan']).toBe(1);
  });

  it('handles empty array lessons field', () => {
    proc.processTrade(makeTrade({ lessons: [] }), defaultContext);

    const result = proc.getResult();
    expect(result.lessonsDistribution).toEqual({});
  });

  it('handles null lessons field', () => {
    proc.processTrade(makeTrade({ lessons: null }), defaultContext);

    const result = proc.getResult();
    expect(result.lessonsDistribution).toEqual({});
  });

  it('handles non-array lessons field (string)', () => {
    proc.processTrade(makeTrade({ lessons: 'Wait for confirmation' }), defaultContext);

    const result = proc.getResult();
    expect(result.lessonsDistribution).toEqual({});
  });

  it('reset clears state', () => {
    proc.processTrade(makeTrade({ lessons: ['Wait for confirmation'] }), defaultContext);
    expect(Object.keys(proc.getResult().lessonsDistribution).length).toBe(1);

    proc.reset();

    const result = proc.getResult();
    expect(result.lessonsDistribution).toEqual({});
  });
});

// ─── LessonsAggregator ─────────────────────────────────────────

describe('LessonsAggregator', () => {
  let agg: LessonsAggregator;

  beforeEach(() => {
    agg = new LessonsAggregator();
  });

  it('merges lessonsDistribution from multiple daily records', () => {
    agg.merge({
      lessonsDistribution: {
        'Wait for confirmation': 3,
        'Use smaller size': 1,
      },
    });
    agg.merge({
      lessonsDistribution: {
        'Wait for confirmation': 2,
        'Follow the plan': 4,
      },
    });

    const result = agg.getResult({});
    expect(result.lessonsDistribution['Wait for confirmation']).toBe(5);
    expect(result.lessonsDistribution['Use smaller size']).toBe(1);
    expect(result.lessonsDistribution['Follow the plan']).toBe(4);
  });

  it('handles records with no lessonsDistribution', () => {
    agg.merge({ lessonsDistribution: { 'Wait for confirmation': 2 } });
    agg.merge({});
    agg.merge({ lessonsDistribution: undefined });

    const result = agg.getResult({});
    expect(result.lessonsDistribution['Wait for confirmation']).toBe(2);
  });

  it('returns empty distribution when no records are merged', () => {
    const result = agg.getResult({});
    expect(result.lessonsDistribution).toEqual({});
  });
});
