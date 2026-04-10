import { MetricProcessor, AggregationProcessor, TradeRecord, AggregationContext } from '../types';

/**
 * Risk/Reward: sumRiskReward, riskRewardCount → avgRiskReward
 * Aggregation strategy: SUM then DIVIDE
 */
export class RiskRewardProcessor implements MetricProcessor {
  readonly name = 'riskReward';
  private sumRR = 0;
  private rrCount = 0;

  processTrade(trade: TradeRecord): void {
    const rr = trade.riskRewardRatio;
    if (rr != null && typeof rr === 'number' && Number.isFinite(rr) && rr > 0) {
      this.sumRR += rr;
      this.rrCount++;
    }
  }

  getResult() {
    return {
      sumRiskReward: this.sumRR,
      riskRewardCount: this.rrCount,
    };
  }

  reset(): void {
    this.sumRR = 0;
    this.rrCount = 0;
  }
}

export class RiskRewardAggregator implements AggregationProcessor {
  readonly name = 'riskReward';
  private sumRR = 0;
  private rrCount = 0;

  merge(record: Record<string, any>): void {
    this.sumRR += record.sumRiskReward || 0;
    this.rrCount += record.riskRewardCount || 0;
  }

  getResult(_context: AggregationContext) {
    return {
      avgRiskReward: this.rrCount > 0 ? this.sumRR / this.rrCount : 0,
    };
  }

  reset(): void {
    this.sumRR = 0;
    this.rrCount = 0;
  }
}
