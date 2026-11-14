import { MetricProcessor, AggregationProcessor, TradeRecord, AggregationContext } from '../types';
import { calcPnL } from '../../utils/pnl';
import { dict } from '../dict';
import { realizedR } from './segments';
import { addTrade, emptyTag, mergeTag, tagResult, tagsOf, type TagEntry, type TagMap, type TagResult } from './mistakes';

/**
 * Broken Rules: tracks which trading rules were broken per day.
 * Stores brokenRulesCounts: Record<ruleId, breakCount> (backward compat)
 * Stores brokenRulesDistribution: Record<ruleId, { count, totalPnl, rSum, rCount }>, and the same for trades that broke
 * no rule (`noBrokenRuleTrades`, the Behaviour tab's baseline).
 * Aggregation strategy: MERGE MAPS (sum counts/pnl per ruleId)
 */
export class BrokenRulesProcessor implements MetricProcessor {
  readonly name = 'brokenRules';
  private counts: Record<string, number> = dict();
  private distribution: TagMap = dict();
  private clean: TagEntry = emptyTag();

  processTrade(trade: TradeRecord): void {
    const ruleIds = tagsOf(trade.brokenRuleIds);
    const pnl = calcPnL(trade) ?? 0;
    const r = realizedR(trade);
    if (ruleIds.length === 0) {
      addTrade(this.clean, pnl, r);
      return;
    }
    for (const ruleId of ruleIds) {
      this.counts[ruleId] = (this.counts[ruleId] || 0) + 1;
      addTrade((this.distribution[ruleId] ??= emptyTag()), pnl, r);
    }
  }

  getResult() {
    return {
      brokenRulesCounts: { ...this.counts },
      brokenRulesDistribution: { ...this.distribution },
      noBrokenRuleTrades: { ...this.clean },
    };
  }

  reset(): void {
    this.counts = dict();
    this.distribution = dict();
    this.clean = emptyTag();
  }
}

export class BrokenRulesAggregator implements AggregationProcessor {
  readonly name = 'brokenRules';
  private merged: Record<string, number> = dict();
  private distribution: TagMap = dict();
  private clean: TagEntry = emptyTag();

  merge(record: Record<string, any>): void {
    const counts = record.brokenRulesCounts || {};
    for (const [ruleId, count] of Object.entries(counts)) {
      this.merged[ruleId] = (this.merged[ruleId] || 0) + (count as number || 0);
    }
    for (const [ruleId, val] of Object.entries((record.brokenRulesDistribution || {}) as TagMap)) mergeTag((this.distribution[ruleId] ??= emptyTag()), val);
    mergeTag(this.clean, record.noBrokenRuleTrades);
  }

  getResult(_context: AggregationContext) {
    const distribution: Record<string, TagResult> = dict();
    for (const [ruleId, e] of Object.entries(this.distribution)) distribution[ruleId] = tagResult(e);
    return {
      brokenRulesCounts: this.merged,
      brokenRulesDistribution: distribution,
      noBrokenRuleTrades: tagResult(this.clean),
    };
  }

  reset(): void {
    this.merged = dict();
    this.distribution = dict();
    this.clean = emptyTag();
  }
}
