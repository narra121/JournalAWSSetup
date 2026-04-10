import { MetricProcessor, AggregationProcessor, TradeRecord, AggregationContext } from '../types';
import { calcPnL } from '../../utils/pnl';

/**
 * Extremes: bestTrade, worstTrade
 * Aggregation strategy: MAX / MIN
 */
export class ExtremesProcessor implements MetricProcessor {
  readonly name = 'extremes';
  private bestTrade = -Infinity;
  private worstTrade = Infinity;

  processTrade(trade: TradeRecord): void {
    const pnl = calcPnL(trade) ?? 0;
    if (pnl > this.bestTrade) this.bestTrade = pnl;
    if (pnl < this.worstTrade) this.worstTrade = pnl;
  }

  getResult() {
    return {
      bestTrade: this.bestTrade === -Infinity ? 0 : this.bestTrade,
      worstTrade: this.worstTrade === Infinity ? 0 : this.worstTrade,
    };
  }

  reset(): void {
    this.bestTrade = -Infinity;
    this.worstTrade = Infinity;
  }
}

export class ExtremesAggregator implements AggregationProcessor {
  readonly name = 'extremes';
  private bestTrade = -Infinity;
  private worstTrade = Infinity;

  merge(record: Record<string, any>): void {
    const best = record.bestTrade ?? -Infinity;
    const worst = record.worstTrade ?? Infinity;
    if (best > this.bestTrade) this.bestTrade = best;
    if (worst < this.worstTrade) this.worstTrade = worst;
  }

  getResult(_context: AggregationContext) {
    return {
      bestTrade: this.bestTrade === -Infinity ? 0 : this.bestTrade,
      worstTrade: this.worstTrade === Infinity ? 0 : this.worstTrade,
    };
  }

  reset(): void {
    this.bestTrade = -Infinity;
    this.worstTrade = Infinity;
  }
}
