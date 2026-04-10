/**
 * Stats Aggregator — core computation engine.
 *
 * computeDailyRecord(): builds a DailyStatsRecord from trades for a single (user, account, day)
 * aggregateDailyRecords(): merges multiple DailyStatsRecords into a final AggregatedStats
 *
 * Both functions delegate to the MetricProcessor/AggregationProcessor registry,
 * so new metrics can be added without modifying this file.
 */
import { DailyStatsRecord, AggregatedStats, AggregationContext } from './metrics/types';
import { metricRegistry } from './metrics/registry';

// Side-effect import: registers all built-in processors
import './metrics/processors/index';

/**
 * Comparator that sorts trades by closeDate (fallback to openDate), ascending.
 */
function byDateComparator(a: any, b: any): number {
  const aTime = new Date(a.closeDate || a.openDate || '').getTime();
  const bTime = new Date(b.closeDate || b.openDate || '').getTime();
  return aTime - bTime;
}

/**
 * Build a DailyStatsRecord for a single (userId, accountId, date) from its trades.
 * If trades is empty, returns null (caller should delete the record).
 */
export function computeDailyRecord(
  userId: string,
  accountId: string,
  date: string,
  trades: any[],
): DailyStatsRecord | null {
  if (trades.length === 0) return null;

  const processors = metricRegistry.getDailyProcessors();
  processors.forEach(p => p.reset());

  const sorted = [...trades].sort(byDateComparator);

  for (let i = 0; i < sorted.length; i++) {
    const ctx = { date, accountId, userId, tradeIndex: i, totalTradesInDay: sorted.length };
    processors.forEach(p => p.processTrade(sorted[i], ctx));
  }

  const record: any = {
    userId,
    sk: `${accountId}#${date}`,
    accountId,
    date,
    dayOfWeek: new Date(date + 'T00:00:00Z').getUTCDay(),
    lastUpdated: new Date().toISOString(),
  };

  processors.forEach(p => Object.assign(record, p.getResult()));

  return record as DailyStatsRecord;
}

/** Default empty stats returned when there are no records to aggregate. */
const EMPTY_STATS: AggregatedStats = {
  totalTrades: 0, wins: 0, losses: 0, breakeven: 0,
  grossProfit: 0, grossLoss: 0, totalPnl: 0, totalVolume: 0,
  winRate: 0, profitFactor: 0, avgWin: 0, avgLoss: 0, expectancy: 0, avgRiskReward: 0,
  bestTrade: 0, worstTrade: 0,
  avgHoldingTime: 0, minDuration: 0, maxDuration: 0,
  consecutiveWins: 0, consecutiveLosses: 0, maxDrawdown: 0, sharpeRatio: 0,
  durationBuckets: [], symbolDistribution: {}, strategyDistribution: {},
  sessionDistribution: {}, outcomeDistribution: {},
  hourlyStats: Array.from({ length: 24 }, (_, i) => ({
    hour: i.toString().padStart(2, '0'), trades: 0, wins: 0, pnl: 0, winRate: 0,
  })),
  dailyWinRate: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map(day => ({
    day, trades: 0, wins: 0, pnl: 0, winRate: 0,
  })),
  dailyPnl: [],
};

/**
 * Aggregate an array of DailyStatsRecords into a single AggregatedStats.
 */
export function aggregateDailyRecords(
  records: DailyStatsRecord[],
  options: AggregationContext = {},
): AggregatedStats {
  if (records.length === 0) return { ...EMPTY_STATS };

  const processors = metricRegistry.getAggregationProcessors();
  processors.forEach(p => p.reset());

  // Sort records by date for correct sequencing of pnlSequence concat
  const sorted = [...records].sort((a, b) => a.date.localeCompare(b.date));

  for (const record of sorted) {
    processors.forEach(p => p.merge(record));
  }

  const result: any = {};
  processors.forEach(p => Object.assign(result, p.getResult(options)));

  return result as AggregatedStats;
}
