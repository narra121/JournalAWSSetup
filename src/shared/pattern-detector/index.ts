/**
 * Pattern Detection Engine — Orchestrator
 *
 * Aggregates all sub-detectors (revenge, overtrading, streaks, time edges,
 * cost of emotion) into a single `detectPatterns()` entry point.
 */

import type { PatternTrade, PatternDetectionResult, CostOfEmotion } from './types.js';
import { detectRevengeTrades } from './revenge.js';
import { detectOvertradeDays } from './overtrading.js';
import { analyzeStreaks } from './streaks.js';
import { analyzeHourlyEdges, analyzeDayOfWeekEdges } from './time-edges.js';
import { calculateCostOfEmotion } from './cost-of-emotion.js';

export type { PatternTrade, PatternDetectionResult } from './types.js';

const EMPTY_COST_OF_EMOTION: CostOfEmotion = {
  revengeTrading: { count: 0, totalPnl: 0, avgPnl: 0 },
  overtrading: { daysCount: 0, excessTradePnl: 0 },
  rulesViolations: { count: 0, totalPnl: 0 },
  totalEmotionalCost: 0,
};

/**
 * Run all pattern detectors on the given trades and return a unified result.
 *
 * 1. Empty input -> default empty result.
 * 2. Sort trades by openDate ascending (single sort, shared by all detectors).
 * 3. Call every sub-detector.
 * 4. Assemble PatternDetectionResult.
 */
export function detectPatterns(trades: PatternTrade[]): PatternDetectionResult {
  if (trades.length === 0) {
    return {
      revengeTrades: [],
      overtradeDays: [],
      streaks: [],
      longestWinStreak: null,
      longestLossStreak: null,
      currentStreak: null,
      hourlyEdges: [],
      dayOfWeekEdges: [],
      costOfEmotion: EMPTY_COST_OF_EMOTION,
      tradeCount: 0,
      dateRange: { start: '', end: '' },
    };
  }

  // Single sort shared by all sub-detectors
  const sorted = [...trades].sort(
    (a, b) => new Date(a.openDate).getTime() - new Date(b.openDate).getTime(),
  );

  // Sub-detectors
  const revengeTrades = detectRevengeTrades(sorted);
  const overtradeDays = detectOvertradeDays(sorted);
  const { streaks, longestWinStreak, longestLossStreak, currentStreak } =
    analyzeStreaks(sorted);
  const hourlyEdges = analyzeHourlyEdges(sorted);
  const dayOfWeekEdges = analyzeDayOfWeekEdges(sorted);
  const costOfEmotion = calculateCostOfEmotion(sorted, revengeTrades, overtradeDays);

  return {
    revengeTrades,
    overtradeDays,
    streaks,
    longestWinStreak,
    longestLossStreak,
    currentStreak,
    hourlyEdges,
    dayOfWeekEdges,
    costOfEmotion,
    tradeCount: trades.length,
    dateRange: {
      start: sorted[0].openDate.slice(0, 10),
      end: sorted[sorted.length - 1].openDate.slice(0, 10),
    },
  };
}
