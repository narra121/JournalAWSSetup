import { MetricProcessor, AggregationProcessor, TradeRecord, AggregationContext } from '../types';

/**
 * Lessons: tracks which lessons were learned per trade.
 * Stores lessonsDistribution: Record<string, number>
 * Aggregation strategy: MERGE MAPS (sum counts per key)
 */
export class LessonsProcessor implements MetricProcessor {
  readonly name = 'lessons';
  private distribution: Record<string, number> = {};

  processTrade(trade: TradeRecord): void {
    const lessons = trade.lessons;
    if (!Array.isArray(lessons)) return;
    for (const lesson of lessons) {
      if (!lesson) continue;
      this.distribution[lesson] = (this.distribution[lesson] || 0) + 1;
    }
  }

  getResult() {
    return { lessonsDistribution: { ...this.distribution } };
  }

  reset(): void {
    this.distribution = {};
  }
}

export class LessonsAggregator implements AggregationProcessor {
  readonly name = 'lessons';
  private distribution: Record<string, number> = {};

  merge(record: Record<string, any>): void {
    const counts = record.lessonsDistribution || {};
    for (const [key, count] of Object.entries(counts)) {
      this.distribution[key] = (this.distribution[key] || 0) + (count as number || 0);
    }
  }

  getResult(_context: AggregationContext) {
    return { lessonsDistribution: this.distribution };
  }

  reset(): void {
    this.distribution = {};
  }
}
