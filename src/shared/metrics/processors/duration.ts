import { MetricProcessor, AggregationProcessor, TradeRecord, AggregationContext } from '../types';
import { calcPnL } from '../../utils/pnl';

const DURATION_RANGES = [
  { key: '<1h', min: 0, max: 1 },
  { key: '1-4h', min: 1, max: 4 },
  { key: '4-8h', min: 4, max: 8 },
  { key: '8-24h', min: 8, max: 24 },
  { key: '>24h', min: 24, max: Infinity },
];

/**
 * Duration: totalDurationHours, durationTradeCount, min/max, durationBuckets
 * Aggregation strategy: SUM (totals), MIN/MAX, MERGE MAPS (buckets)
 */
export class DurationProcessor implements MetricProcessor {
  readonly name = 'duration';
  private totalDurationHours = 0;
  private durationTradeCount = 0;
  private minDurationHours = Infinity;
  private maxDurationHours = 0;
  private buckets: Record<string, { total: number; wins: number; losses: number }> = {};

  processTrade(trade: TradeRecord): void {
    if (!trade.closeDate || !trade.openDate) return;
    const durationMs = new Date(trade.closeDate).getTime() - new Date(trade.openDate).getTime();
    const durationHours = durationMs / 3_600_000;
    if (durationHours < 0) return;

    this.totalDurationHours += durationHours;
    this.durationTradeCount++;
    if (durationHours < this.minDurationHours) this.minDurationHours = durationHours;
    if (durationHours > this.maxDurationHours) this.maxDurationHours = durationHours;

    const pnl = calcPnL(trade) ?? 0;
    const isWin = pnl > 0;
    const range = DURATION_RANGES.find(r => durationHours >= r.min && durationHours < r.max);
    if (range) {
      if (!this.buckets[range.key]) this.buckets[range.key] = { total: 0, wins: 0, losses: 0 };
      this.buckets[range.key].total++;
      if (isWin) this.buckets[range.key].wins++;
      else if (pnl < 0) this.buckets[range.key].losses++;
    }
  }

  getResult() {
    return {
      totalDurationHours: this.totalDurationHours,
      durationTradeCount: this.durationTradeCount,
      minDurationHours: this.minDurationHours === Infinity ? 0 : this.minDurationHours,
      maxDurationHours: this.maxDurationHours,
      durationBuckets: { ...this.buckets },
    };
  }

  reset(): void {
    this.totalDurationHours = 0;
    this.durationTradeCount = 0;
    this.minDurationHours = Infinity;
    this.maxDurationHours = 0;
    this.buckets = {};
  }
}

export class DurationAggregator implements AggregationProcessor {
  readonly name = 'duration';
  private totalDurationHours = 0;
  private durationTradeCount = 0;
  private minDuration = Infinity;
  private maxDuration = 0;
  private mergedBuckets: Record<string, { total: number; wins: number; losses: number }> = {};

  merge(record: Record<string, any>): void {
    this.totalDurationHours += record.totalDurationHours || 0;
    this.durationTradeCount += record.durationTradeCount || 0;
    if ((record.durationTradeCount || 0) > 0) {
      const min = record.minDurationHours ?? Infinity;
      if (min < this.minDuration) this.minDuration = min;
    }
    const max = record.maxDurationHours ?? 0;
    if (max > this.maxDuration) this.maxDuration = max;

    const buckets = record.durationBuckets || {};
    for (const [key, val] of Object.entries(buckets) as [string, any][]) {
      if (!this.mergedBuckets[key]) this.mergedBuckets[key] = { total: 0, wins: 0, losses: 0 };
      this.mergedBuckets[key].total += val.total || 0;
      this.mergedBuckets[key].wins += val.wins || 0;
      this.mergedBuckets[key].losses += val.losses || 0;
    }
  }

  getResult(_context: AggregationContext) {
    const orderedKeys = ['<1h', '1-4h', '4-8h', '8-24h', '>24h'];
    const durationBuckets = orderedKeys
      .filter(k => this.mergedBuckets[k])
      .map(k => ({ range: k, ...this.mergedBuckets[k] }));

    return {
      avgHoldingTime: this.durationTradeCount > 0 ? this.totalDurationHours / this.durationTradeCount : 0,
      minDuration: this.minDuration === Infinity ? 0 : this.minDuration,
      maxDuration: this.maxDuration,
      durationBuckets,
    };
  }

  reset(): void {
    this.totalDurationHours = 0;
    this.durationTradeCount = 0;
    this.minDuration = Infinity;
    this.maxDuration = 0;
    this.mergedBuckets = {};
  }
}
