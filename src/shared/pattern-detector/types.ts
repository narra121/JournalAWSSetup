/**
 * Pattern Detection Engine — Types & Interfaces
 *
 * Defines the data structures used by all pattern detectors
 * (revenge trading, overtrading, streaks, hourly/daily edges, emotional cost).
 */

/** Normalized trade record consumed by pattern detectors. */
export interface PatternTrade {
  tradeId: string;
  symbol: string;
  accountId: string;
  openDate: string;
  closeDate: string | null;
  pnl: number;
  quantity: number;
  entryPrice: number;
  exitPrice: number | null;
  side: 'BUY' | 'SELL';
  brokenRules?: string[];
  mistakes?: string;
  strategy?: string;
  session?: string;
}

/** A revenge-trade signal: a trade opened too quickly after a loss. */
export interface RevengeTradeSignal {
  tradeId: string;
  triggerTradeId: string;
  gapMinutes: number;
  triggerPnl: number;
  revengePnl: number;
}

/** A day flagged as overtrading (count > 1.5x daily average). */
export interface OvertradeDay {
  date: string;
  tradeCount: number;
  pnl: number;
  avgTradesPerDay: number;
}

/** A consecutive win or loss streak. */
export interface StreakInfo {
  type: 'win' | 'loss';
  length: number;
  totalPnl: number;
  startDate: string;
  endDate: string;
  tradeIds: string[];
}

/** Hourly performance edge for a specific hour of the day. */
export interface HourlyEdge {
  hour: number;
  tradeCount: number;
  winRate: number;
  avgPnl: number;
  totalPnl: number;
  label: 'green_zone' | 'red_zone' | 'neutral';
}

/** Day-of-week performance edge. */
export interface DayOfWeekEdge {
  day: number;
  dayName: string;
  tradeCount: number;
  winRate: number;
  avgPnl: number;
  totalPnl: number;
  label: 'green_zone' | 'red_zone' | 'neutral';
}

/** Aggregate emotional cost breakdown. */
export interface CostOfEmotion {
  revengeTrading: {
    count: number;
    totalPnl: number;
    avgPnl: number;
  };
  overtrading: {
    daysCount: number;
    excessTradePnl: number;
  };
  rulesViolations: {
    count: number;
    totalPnl: number;
  };
  totalEmotionalCost: number;
}

/** Full result returned by the pattern detection engine. */
export interface PatternDetectionResult {
  revengeTrades: RevengeTradeSignal[];
  overtradeDays: OvertradeDay[];
  streaks: StreakInfo[];
  longestWinStreak: StreakInfo | null;
  longestLossStreak: StreakInfo | null;
  currentStreak: StreakInfo | null;
  hourlyEdges: HourlyEdge[];
  dayOfWeekEdges: DayOfWeekEdge[];
  costOfEmotion: CostOfEmotion;
  tradeCount: number;
  dateRange: {
    start: string;
    end: string;
  };
}
