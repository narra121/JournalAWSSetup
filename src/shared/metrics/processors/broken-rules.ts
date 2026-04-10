import { MetricProcessor, AggregationProcessor, TradeRecord, AggregationContext } from '../types';

/**
 * Broken Rules: tracks which trading rules were broken per day.
 * Stores brokenRulesCounts: Record<ruleId, breakCount>
 * Aggregation strategy: MERGE MAPS (sum counts per ruleId)
 */
export class BrokenRulesProcessor implements MetricProcessor {
  readonly name = 'brokenRules';
  private counts: Record<string, number> = {};

  processTrade(trade: TradeRecord): void {
    const ruleIds = trade.brokenRuleIds;
    if (!Array.isArray(ruleIds)) return;
    for (const ruleId of ruleIds) {
      if (ruleId) this.counts[ruleId] = (this.counts[ruleId] || 0) + 1;
    }
  }

  getResult() {
    return { brokenRulesCounts: { ...this.counts } };
  }

  reset(): void {
    this.counts = {};
  }
}

export class BrokenRulesAggregator implements AggregationProcessor {
  readonly name = 'brokenRules';
  private merged: Record<string, number> = {};

  merge(record: Record<string, any>): void {
    const counts = record.brokenRulesCounts || {};
    for (const [ruleId, count] of Object.entries(counts)) {
      this.merged[ruleId] = (this.merged[ruleId] || 0) + (count as number || 0);
    }
  }

  getResult(_context: AggregationContext) {
    return { brokenRulesCounts: this.merged };
  }

  reset(): void {
    this.merged = {};
  }
}
