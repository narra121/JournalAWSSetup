/**
 * Overtrading Detector
 *
 * Identifies days where the trade count significantly exceeds (>1.5x)
 * the average daily trade count, indicating possible overtrading.
 */

import type { PatternTrade, OvertradeDay } from './types.js';

/**
 * Detect overtrade days: days where trade count exceeds 1.5x the daily average.
 *
 * Logic:
 * 1. Group trades by date (openDate YYYY-MM-DD).
 * 2. Require at least 5 distinct trading days for meaningful detection.
 * 3. Compute avgTradesPerDay = totalTrades / numTradingDays.
 * 4. Flag days where count > avg * 1.5.
 * 5. Return sorted by date ascending.
 */
export function detectOvertradeDays(trades: PatternTrade[]): OvertradeDay[] {
  if (trades.length === 0) return [];

  // Group trades by date
  const dayMap = new Map<string, { count: number; pnl: number }>();

  for (const trade of trades) {
    const date = trade.openDate.slice(0, 10); // YYYY-MM-DD
    const existing = dayMap.get(date);
    if (existing) {
      existing.count += 1;
      existing.pnl += trade.pnl;
    } else {
      dayMap.set(date, { count: 1, pnl: trade.pnl });
    }
  }

  const numDays = dayMap.size;

  // Need at least 5 trading days for meaningful detection
  if (numDays < 5) return [];

  const avgTradesPerDay = trades.length / numDays;
  const threshold = avgTradesPerDay * 1.5;

  const results: OvertradeDay[] = [];

  for (const [date, { count, pnl }] of dayMap.entries()) {
    if (count > threshold) {
      results.push({
        date,
        tradeCount: count,
        pnl: Math.round(pnl * 100) / 100,
        avgTradesPerDay: Math.round(avgTradesPerDay * 100) / 100,
      });
    }
  }

  // Sort by date ascending
  results.sort((a, b) => a.date.localeCompare(b.date));

  return results;
}
