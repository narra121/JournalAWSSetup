import { MetricProcessor, AggregationProcessor } from './types';

/**
 * Registry for metric processors.
 *
 * New metrics are added by creating a processor and calling register() —
 * no modifications to computeDailyRecord or aggregateDailyRecords needed.
 */
class MetricRegistry {
  private dailyProcessors: MetricProcessor[] = [];
  private aggregationProcessors: AggregationProcessor[] = [];

  registerDaily(processor: MetricProcessor): void {
    this.dailyProcessors.push(processor);
  }

  registerAggregation(processor: AggregationProcessor): void {
    this.aggregationProcessors.push(processor);
  }

  getDailyProcessors(): MetricProcessor[] {
    return this.dailyProcessors;
  }

  getAggregationProcessors(): AggregationProcessor[] {
    return this.aggregationProcessors;
  }
}

export const metricRegistry = new MetricRegistry();
