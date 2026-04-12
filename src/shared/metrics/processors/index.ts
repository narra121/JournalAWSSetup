/**
 * Built-in processor registration.
 *
 * To add a new metric:
 * 1. Create a new processor file (e.g., market-condition.ts)
 * 2. Import and register it here
 * No changes to stats-aggregator, stream handler, or API needed.
 */
import { metricRegistry } from '../registry';

import { CoreStatsProcessor, CoreStatsAggregator } from './core-stats';
import { ExtremesProcessor, ExtremesAggregator } from './extremes';
import { RiskRewardProcessor, RiskRewardAggregator } from './risk-reward';
import { DurationProcessor, DurationAggregator } from './duration';
import { DistributionsProcessor, DistributionsAggregator } from './distributions';
import { HourlyProcessor, HourlyAggregator } from './hourly';
import { PnlSequenceProcessor, PnlSequenceAggregator } from './pnl-sequence';
import { DayOfWeekAggregator } from './day-of-week';
import { BrokenRulesProcessor, BrokenRulesAggregator } from './broken-rules';
import { MistakesProcessor, MistakesAggregator } from './mistakes';
import { LessonsProcessor, LessonsAggregator } from './lessons';

// --- Daily processors (run per-trade when building daily record) ---
metricRegistry.registerDaily(new CoreStatsProcessor());
metricRegistry.registerDaily(new ExtremesProcessor());
metricRegistry.registerDaily(new RiskRewardProcessor());
metricRegistry.registerDaily(new DurationProcessor());
metricRegistry.registerDaily(new DistributionsProcessor());
metricRegistry.registerDaily(new HourlyProcessor());
metricRegistry.registerDaily(new PnlSequenceProcessor());
metricRegistry.registerDaily(new BrokenRulesProcessor());
metricRegistry.registerDaily(new MistakesProcessor());
metricRegistry.registerDaily(new LessonsProcessor());

// --- Aggregation processors (run per-daily-record when building response) ---
metricRegistry.registerAggregation(new CoreStatsAggregator());
metricRegistry.registerAggregation(new ExtremesAggregator());
metricRegistry.registerAggregation(new RiskRewardAggregator());
metricRegistry.registerAggregation(new DurationAggregator());
metricRegistry.registerAggregation(new DistributionsAggregator());
metricRegistry.registerAggregation(new HourlyAggregator());
metricRegistry.registerAggregation(new PnlSequenceAggregator());
metricRegistry.registerAggregation(new DayOfWeekAggregator());
metricRegistry.registerAggregation(new BrokenRulesAggregator());
metricRegistry.registerAggregation(new MistakesAggregator());
metricRegistry.registerAggregation(new LessonsAggregator());
