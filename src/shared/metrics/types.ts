/**
 * Metric Processor System — Types & Interfaces
 *
 * Implements the Strategy + Registry pattern so new metrics can be added
 * by creating a processor file and registering it — no changes to existing code.
 */

/** Normalized trade record from DynamoDB (all fields available). */
export interface TradeRecord {
  userId: string;
  tradeId: string;
  symbol: string;
  side: 'BUY' | 'SELL';
  quantity: number;
  openDate: string;
  closeDate?: string | null;
  entryPrice?: number | null;
  exitPrice?: number | null;
  stopLoss?: number | null;
  takeProfit?: number | null;
  pnl?: number | null;
  riskRewardRatio?: number | null;
  outcome?: string | null;
  setupType?: string | null;
  tradingSession?: string | null;
  marketCondition?: string | null;
  accountId?: string;
  tags?: string[];
  [key: string]: any;
}

/** Context passed to each processor for every trade. */
export interface ProcessorContext {
  date: string;
  accountId: string;
  userId: string;
  tradeIndex: number;
  totalTradesInDay: number;
}

/** Context for aggregation across daily records. */
export interface AggregationContext {
  totalCapital?: number;
  includeEquityCurve?: boolean;
}

/**
 * Daily metric processor — called once per trade during daily record computation.
 * Each processor handles one category of stats (SRP).
 */
export interface MetricProcessor {
  /** Unique name for this processor */
  readonly name: string;

  /** Called once per trade (trades are sorted by closeDate||openDate) */
  processTrade(trade: TradeRecord, context: ProcessorContext): void;

  /** Return computed fields to merge into the DailyStatsRecord */
  getResult(): Record<string, any>;

  /** Reset state for next daily record computation */
  reset(): void;
}

/**
 * Aggregation processor — merges daily records into a final aggregated result.
 * Each processor encapsulates its own aggregation strategy (SUM, MIN/MAX, CONCAT).
 */
export interface AggregationProcessor {
  /** Unique name (typically matches the MetricProcessor it aggregates) */
  readonly name: string;

  /** Merge one daily record's fields into running aggregation */
  merge(dailyRecord: Record<string, any>): void;

  /** Return final aggregated fields to merge into AggregatedStats */
  getResult(context: AggregationContext): Record<string, any>;

  /** Reset state */
  reset(): void;
}

/** Shape of a single daily stats record stored in DynamoDB. */
export interface DailyStatsRecord {
  userId: string;
  sk: string;            // "{accountId}#YYYY-MM-DD"
  accountId: string;
  date: string;          // "YYYY-MM-DD"
  dayOfWeek: number;     // 0=Sun..6=Sat
  lastUpdated: string;
  tradeHash?: string;
  // All other fields are contributed by MetricProcessors
  [key: string]: any;
}

/** Shape of a monthly hash record stored in DynamoDB (for two-level cache verification). */
export interface MonthlyHashRecord {
  userId: string;
  sk: string;            // "{accountId}#MONTH#{YYYY-MM}"
  accountId: string;
  month: string;         // "YYYY-MM"
  monthHash: string;     // SHA-256 of sorted day hashes
  lastUpdated: string;
}

/** Final aggregated stats returned by GET /v1/stats. */
export interface AggregatedStats {
  totalTrades: number;
  wins: number;
  losses: number;
  breakeven: number;
  grossProfit: number;
  grossLoss: number;
  totalPnl: number;
  totalVolume: number;

  winRate: number;
  profitFactor: number;
  avgWin: number;
  avgLoss: number;
  expectancy: number;
  avgRiskReward: number;

  bestTrade: number;
  worstTrade: number;

  avgHoldingTime: number;
  minDuration: number;
  maxDuration: number;

  consecutiveWins: number;
  consecutiveLosses: number;
  maxDrawdown: number;
  sharpeRatio: number;

  durationBuckets: Array<{ range: string; wins: number; losses: number; total: number }>;
  symbolDistribution: Record<string, { count: number; wins: number; pnl: number }>;
  strategyDistribution: Record<string, { count: number; wins: number; pnl: number }>;
  sessionDistribution: Record<string, { count: number; wins: number; pnl: number }>;
  outcomeDistribution: Record<string, number>;
  hourlyStats: Array<{ hour: string; trades: number; wins: number; pnl: number; winRate: number }>;
  dailyWinRate: Array<{ day: string; trades: number; wins: number; pnl: number; winRate: number }>;

  dailyPnl: Array<{ date: string; pnl: number; cumulativePnl: number }>;
  equityCurve?: Array<{ date: string; pnl: number; cumulativePnl: number; symbol: string }>;

  // Allow new fields from future processors
  [key: string]: any;
}
