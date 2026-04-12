import { MetricProcessor, AggregationProcessor, TradeRecord, AggregationContext } from '../types';
import { calcPnL } from '../../utils/pnl';

type MistakeEntry = { count: number; totalPnl: number };
type MistakeMap = Record<string, MistakeEntry>;

function mergeMistakes(target: MistakeMap, source: MistakeMap): void {
  for (const [key, val] of Object.entries(source)) {
    if (!target[key]) target[key] = { count: 0, totalPnl: 0 };
    target[key].count += val.count || 0;
    target[key].totalPnl += val.totalPnl || 0;
  }
}

/**
 * Mistakes: tracks which mistakes were made per trade, with PnL impact.
 * Stores mistakesDistribution: Record<string, { count, totalPnl }>
 * Aggregation strategy: MERGE MAPS (sum count + totalPnl per key)
 */
export class MistakesProcessor implements MetricProcessor {
  readonly name = 'mistakes';
  private distribution: MistakeMap = {};

  processTrade(trade: TradeRecord): void {
    const mistakes = trade.mistakes;
    if (!Array.isArray(mistakes)) return;
    const pnl = calcPnL(trade) ?? 0;
    for (const mistake of mistakes) {
      if (!mistake) continue;
      if (!this.distribution[mistake]) this.distribution[mistake] = { count: 0, totalPnl: 0 };
      this.distribution[mistake].count++;
      this.distribution[mistake].totalPnl += pnl;
    }
  }

  getResult() {
    return { mistakesDistribution: { ...this.distribution } };
  }

  reset(): void {
    this.distribution = {};
  }
}

export class MistakesAggregator implements AggregationProcessor {
  readonly name = 'mistakes';
  private distribution: MistakeMap = {};

  merge(record: Record<string, any>): void {
    mergeMistakes(this.distribution, record.mistakesDistribution || {});
  }

  getResult(_context: AggregationContext) {
    return { mistakesDistribution: this.distribution };
  }

  reset(): void {
    this.distribution = {};
  }
}
