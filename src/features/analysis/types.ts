// Single source of the Analysis API types (CONTRACT I4). The frontend copies this file to TradeFlow src/types/analysis.ts.
// Units everywhere: rates and shares are fractions (0.533 = 53.3%), money is in the account currency rounded to cents,
// R is realised R (CONTRACT I2), holding times are minutes, days are YYYY-MM-DD in the user's time zone.

export type SampleLabel = 'too-few' | 'early' | 'provisional' | 'established';
export type Verdict = 'edge' | 'leak' | 'watch';

/** 95% range; null below 20 trades (too few for a range). */
export interface Range {
  lo: number;
  hi: number;
}

export const DIMENSIONS = [
  'symbol', 'setup', 'session', 'direction', 'assetClass', 'weekday', 'hour', 'marketCondition', 'newsEvent', 'tag',
  'plannedRR', 'holding', 'tradeNumber', 'optionType', 'expiryDay',
] as const;
export type Dimension = (typeof DIMENSIONS)[number];

export interface Segment {
  key: string;
  name: string;
  trades: number;
  wins: number;
  winRate: number;
  winRateRange: Range | null;
  net: number;
  /** money won ÷ money lost; null without a losing trade */
  profitFactor: number | null;
  /** null when no trade in the segment has an R (no stop recorded) */
  avgR: number | null;
  avgRRange: Range | null;
  verdict: Verdict;
  label: SampleLabel;
  tradeIds: string[];
  /** trades-per-day bands only: the number of days in the band (net ÷ days = the average day) */
  days?: number;
}

export interface EdgeSummary {
  winRate: number;
  winRateRange: Range | null;
  /** average win ÷ average loss; null without both wins and losses */
  payoff: number | null;
  /** win rate (over all trades, like winRate) at which net P&L would be zero at the current payoff; 1 ÷ (1 + payoff) when no trade is break-even */
  breakEvenWinRate: number | null;
  expectancyMoney: number | null;
  expectancyR: number | null;
  expectancyRRange: Range | null;
  tradesWithR: number;
  /** trades with an R needed before the expectancy range would exclude zero at today's spread; null when it already does or cannot be estimated */
  tradesNeeded: number | null;
}

/** Signed parts that add up to `net`: gross profit is positive, every loss and the fees are negative. */
export interface ResultBridge {
  grossProfit: number;
  lossesWithinPlan: number;
  lossesBeyondStop: number;
  /** losing trades without a stop: their risk is unknown, so they cannot be split */
  lossesWithoutStop: number;
  fees: number;
  net: number;
  losingTrades: number;
  beyondStopTrades: number;
}

export interface Concentration {
  /** how many best and worst trades are counted (3, or fewer when there are fewer wins or losses) */
  top: number;
  bestShareOfProfit: number | null;
  netWithoutBest: number;
  worstShareOfLosses: number | null;
  netWithoutWorst: number;
  bestTradeIds: string[];
  worstTradeIds: string[];
}

export interface RollingPoint {
  /** close day; one point per day, the value after that day's last trade */
  date: string;
  /** average R of the last 20 trades with an R */
  avgR: number;
}

export interface RiskExtras {
  avgR: number | null;
  /** standard deviation of R per trade */
  rSpread: number | null;
  beyondStop: { count: number; losingTrades: number; amount: number; tradeIds: string[] };
  /** winners with a planned R:R and an R; null when there are none */
  plannedVsCaptured: { winners: number; plannedAvgR: number; capturedAvgR: number; captureRatio: number; reachedTarget: number; tradeIds: string[] } | null;
  /** money at the stop per trade; the shares are of the starting balance and null when it is unknown */
  riskPerTrade: {
    trades: number;
    median: number;
    largest: number;
    medianShareOfBalance: number | null;
    largestShareOfBalance: number | null;
    aboveMultiple: { multiple: number; count: number; net: number; tradeIds: string[] };
  } | null;
  /** from the daily close series; `longestDays` is calendar days below the previous high, `since` the day the current drawdown began */
  drawdown: { current: number; deepest: number; longestDays: number; since: string | null };
}

export interface Timing {
  byTradeNumber: Segment[];
  holding: { winnersMedianMin: number | null; losersMedianMin: number | null };
  tradesPerDay: Segment[];
}

export const DETECTOR_IDS = [
  'reentryAfterLoss', 'afterLoss', 'sizeUpAfterLoss', 'tradeNumber', 'overtradingDay', 'beyondStop', 'noStop',
  'targetNotReached', 'losersHeldLonger', 'fees', 'brokenRule', 'afterDailyLimit', 'expiryDay',
] as const;
export type DetectorId = (typeof DETECTOR_IDS)[number];

export interface Detector {
  id: DetectorId;
  title: string;
  /** trades the behaviour applies to */
  count: number;
  net: number;
  avgR: number | null;
  /** average R of the comparison group (named in `detail`) */
  normalAvgR: number | null;
  verdict: Verdict;
  label: SampleLabel;
  tradeIds: string[];
  detail: string;
}

export interface Scenario {
  /** trades resampled */
  basedOn: number;
  runs: number;
  /** trades per run */
  horizon: number;
  profitableShare: number;
  final: { p5: number; p50: number; p95: number };
  maxDrawdown: { p50: number; p95: number };
  /** share of runs whose drawdown reaches `amount` (5% of the starting balance, else the deepest drawdown so far) */
  drawdownRisk: { amount: number; share: number } | null;
  /** ±10% of the starting balance: share of runs reaching each first; null when the balance is unknown */
  targetBeforeLimit: { target: number; limit: number; targetFirst: number; limitFirst: number } | null;
}

export interface Analysis {
  period: { from: string; to: string; timeZone: string };
  currency: string | null;
  tradeCount: number;
  /** the period holds more than 5,000 trades: every figure covers the oldest 5,000 only */
  truncated: boolean;
  label: SampleLabel;
  edge: EdgeSummary;
  bridge: ResultBridge;
  concentration: Concentration;
  rolling: RollingPoint[];
  risk: RiskExtras;
  timing: Timing;
  segments: Record<Dimension, Segment[]>;
  detectors: Detector[];
  scenario: Scenario | null;
}

export type WhatIfRule =
  | { kind: 'stopAfterLosses'; n: number }
  | { kind: 'maxTradesPerDay'; n: number }
  /** trades opened at or after this local time are not taken */
  | { kind: 'noTradesAfter'; time: string }
  | { kind: 'skipSegment'; dimension: Dimension; key: string }
  /** trades risking more than `multiple` × the median money at risk are not taken */
  | { kind: 'maxRiskMultiple'; multiple: number };

export interface WhatIfResult {
  actualNet: number;
  replayNet: number;
  removed: number;
  removedTradeIds: string[];
  actualAvgR: number | null;
  replayAvgR: number | null;
}

/** Keys or names of a dimension's segments (case-insensitive). */
export type QueryFilters = Partial<Record<Dimension, string>>;
export interface PeriodBounds {
  from: string;
  to: string;
}

export type AnalysisQuery =
  | { kind: 'stats'; groupBy: Dimension[]; filters?: QueryFilters }
  | { kind: 'sequence'; after: 'loss' | 'win'; sameDay: boolean; withinMinutes?: number }
  | { kind: 'whatIf'; rule: WhatIfRule }
  /** `order` defaults to 'desc' (best, largest R or newest first) */
  | { kind: 'trades'; filters?: QueryFilters; sort: 'pnl' | 'r' | 'date'; order?: 'asc' | 'desc'; limit: number }
  | { kind: 'compare'; a: PeriodBounds; b: PeriodBounds };

export interface QueryResult {
  columns: string[];
  rows: (string | number | null)[][];
  label: SampleLabel;
  note?: string;
  tradeIds: string[];
}
