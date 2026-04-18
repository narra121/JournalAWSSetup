/**
 * Revenge Trade Detector
 *
 * Identifies trades opened too quickly (within 15 minutes) after a losing trade,
 * which is a common emotional/revenge-trading pattern.
 */

import type { PatternTrade, RevengeTradeSignal } from './types.js';

/**
 * Detect revenge trades: trades opened within 15 minutes of a losing trade's close.
 *
 * Logic:
 * 1. Sort trades by openDate ascending.
 * 2. For each consecutive pair, if the previous trade lost (pnl < 0)
 *    AND the current trade's openDate is within 15 minutes of the
 *    previous trade's closeDate (or openDate if closeDate is null),
 *    flag the current trade as a revenge trade.
 * 3. Chains work naturally — each pair is checked independently.
 */
export function detectRevengeTrades(trades: PatternTrade[]): RevengeTradeSignal[] {
  if (trades.length < 2) return [];

  const sorted = [...trades].sort(
    (a, b) => new Date(a.openDate).getTime() - new Date(b.openDate).getTime(),
  );

  const signals: RevengeTradeSignal[] = [];

  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1];
    const curr = sorted[i];

    // Only flag after a loss
    if (prev.pnl >= 0) continue;

    const prevEndTime = new Date(prev.closeDate ?? prev.openDate).getTime();
    const currStartTime = new Date(curr.openDate).getTime();
    const gapMs = currStartTime - prevEndTime;
    const gapMinutes = gapMs / (1000 * 60);

    // Must be within 15 minutes (and not before — negative gap)
    if (gapMinutes < 0 || gapMinutes > 15) continue;

    signals.push({
      tradeId: curr.tradeId,
      triggerTradeId: prev.tradeId,
      gapMinutes: Math.round(gapMinutes * 100) / 100, // 2 decimal places
      triggerPnl: prev.pnl,
      revengePnl: curr.pnl,
    });
  }

  return signals;
}
