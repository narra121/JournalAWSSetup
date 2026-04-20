import { MetricProcessor, AggregationProcessor, TradeRecord, AggregationContext } from '../types';
import { calcPnL } from '../../utils/pnl';

type DistMap = Record<string, { count: number; wins: number; pnl: number }>;

function mergeDist(target: DistMap, source: DistMap): void {
  for (const [key, val] of Object.entries(source)) {
    if (!target[key]) target[key] = { count: 0, wins: 0, pnl: 0 };
    target[key].count += val.count || 0;
    target[key].wins += val.wins || 0;
    target[key].pnl += val.pnl || 0;
  }
}

function mergeCountDist(target: Record<string, number>, source: Record<string, number>): void {
  for (const [key, val] of Object.entries(source)) {
    target[key] = (target[key] || 0) + (val || 0);
  }
}

/**
 * Distributions: symbol, strategy, session, outcome
 * Aggregation strategy: MERGE MAPS (sum counts/wins/pnl per key)
 */
export class DistributionsProcessor implements MetricProcessor {
  readonly name = 'distributions';
  private symbolDist: DistMap = {};
  private strategyDist: DistMap = {};
  private sessionDist: DistMap = {};
  private outcomeDist: Record<string, number> = {};

  processTrade(trade: TradeRecord): void {
    const pnl = calcPnL(trade) ?? 0;
    const isWin = pnl > 0;

    // Symbol
    const symbol = trade.symbol || 'Unknown';
    if (!this.symbolDist[symbol]) this.symbolDist[symbol] = { count: 0, wins: 0, pnl: 0 };
    this.symbolDist[symbol].count++;
    if (isWin) this.symbolDist[symbol].wins++;
    this.symbolDist[symbol].pnl += pnl;

    // Strategy
    const strategy = trade.setupType || 'Unknown';
    if (!this.strategyDist[strategy]) this.strategyDist[strategy] = { count: 0, wins: 0, pnl: 0 };
    this.strategyDist[strategy].count++;
    if (isWin) this.strategyDist[strategy].wins++;
    this.strategyDist[strategy].pnl += pnl;

    // Session
    const session = trade.tradingSession || 'Unknown';
    if (!this.sessionDist[session]) this.sessionDist[session] = { count: 0, wins: 0, pnl: 0 };
    this.sessionDist[session].count++;
    if (isWin) this.sessionDist[session].wins++;
    this.sessionDist[session].pnl += pnl;

    // Outcome
    const outcome = trade.outcome || 'Unknown';
    this.outcomeDist[outcome] = (this.outcomeDist[outcome] || 0) + 1;
  }

  getResult() {
    return {
      symbolDistribution: { ...this.symbolDist },
      strategyDistribution: { ...this.strategyDist },
      sessionDistribution: { ...this.sessionDist },
      outcomeDistribution: { ...this.outcomeDist },
    };
  }

  reset(): void {
    this.symbolDist = {};
    this.strategyDist = {};
    this.sessionDist = {};
    this.outcomeDist = {};
  }
}

export class DistributionsAggregator implements AggregationProcessor {
  readonly name = 'distributions';
  private symbolDist: DistMap = {};
  private strategyDist: DistMap = {};
  private sessionDist: DistMap = {};
  private outcomeDist: Record<string, number> = {};

  merge(record: Record<string, any>): void {
    mergeDist(this.symbolDist, record.symbolDistribution || {});
    mergeDist(this.strategyDist, record.strategyDistribution || {});
    mergeDist(this.sessionDist, record.sessionDistribution || {});
    mergeCountDist(this.outcomeDist, record.outcomeDistribution || {});
  }

  getResult(_context: AggregationContext) {
    return {
      symbolDistribution: this.symbolDist,
      strategyDistribution: this.strategyDist,
      sessionDistribution: this.sessionDist,
      outcomeDistribution: this.outcomeDist,
    };
  }

  reset(): void {
    this.symbolDist = {};
    this.strategyDist = {};
    this.sessionDist = {};
    this.outcomeDist = {};
  }
}
