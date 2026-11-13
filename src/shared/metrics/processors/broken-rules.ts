import { MetricProcessor, AggregationProcessor, TradeRecord, AggregationContext } from '../types';
import { calcPnL } from '../../utils/pnl';
import { dict } from '../dict';

type BrokenRuleEntry = { count: number; totalPnl: number };
type BrokenRuleDistMap = Record<string, BrokenRuleEntry>;

function mergeBrokenRuleDist(target: BrokenRuleDistMap, source: BrokenRuleDistMap): void {
  for (const [key, val] of Object.entries(source)) {
    if (!target[key]) target[key] = { count: 0, totalPnl: 0 };
    target[key].count += val.count || 0;
    target[key].totalPnl += val.totalPnl || 0;
  }
}

/**
 * Broken Rules: tracks which trading rules were broken per day.
 * Stores brokenRulesCounts: Record<ruleId, breakCount> (backward compat)
 * Stores brokenRulesDistribution: Record<ruleId, { count, totalPnl }> (new)
 * Aggregation strategy: MERGE MAPS (sum counts/pnl per ruleId)
 */
export class BrokenRulesProcessor implements MetricProcessor {
  readonly name = 'brokenRules';
  private counts: Record<string, number> = dict();
  private distribution: BrokenRuleDistMap = dict();

  processTrade(trade: TradeRecord): void {
    const ruleIds = trade.brokenRuleIds;
    if (!Array.isArray(ruleIds)) return;
    const pnl = calcPnL(trade) ?? 0;
    for (const ruleId of ruleIds) {
      if (!ruleId || typeof ruleId !== 'string') continue;
      this.counts[ruleId] = (this.counts[ruleId] || 0) + 1;
      if (!this.distribution[ruleId]) this.distribution[ruleId] = { count: 0, totalPnl: 0 };
      this.distribution[ruleId].count++;
      this.distribution[ruleId].totalPnl += pnl;
    }
  }

  getResult() {
    return {
      brokenRulesCounts: { ...this.counts },
      brokenRulesDistribution: { ...this.distribution },
    };
  }

  reset(): void {
    this.counts = dict();
    this.distribution = dict();
  }
}

export class BrokenRulesAggregator implements AggregationProcessor {
  readonly name = 'brokenRules';
  private merged: Record<string, number> = dict();
  private distribution: BrokenRuleDistMap = dict();

  merge(record: Record<string, any>): void {
    const counts = record.brokenRulesCounts || {};
    for (const [ruleId, count] of Object.entries(counts)) {
      this.merged[ruleId] = (this.merged[ruleId] || 0) + (count as number || 0);
    }
    mergeBrokenRuleDist(this.distribution, record.brokenRulesDistribution || {});
  }

  getResult(_context: AggregationContext) {
    return {
      brokenRulesCounts: this.merged,
      brokenRulesDistribution: this.distribution,
    };
  }

  reset(): void {
    this.merged = dict();
    this.distribution = dict();
  }
}
