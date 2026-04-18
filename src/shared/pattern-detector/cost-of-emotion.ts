import { PatternTrade, RevengeTradeSignal, OvertradeDay, CostOfEmotion } from './types';

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export function calculateCostOfEmotion(
  trades: PatternTrade[],
  revengeSignals: RevengeTradeSignal[],
  overtradeDays: OvertradeDay[]
): CostOfEmotion {
  // Revenge trading
  const revengeTradeIds = new Set(revengeSignals.map((s) => s.tradeId));
  const revengeCount = revengeSignals.length;
  const revengeTotalPnl = trades
    .filter((t) => revengeTradeIds.has(t.tradeId))
    .reduce((sum, t) => sum + t.pnl, 0);
  const revengeAvgPnl = revengeCount > 0 ? round2(revengeTotalPnl / revengeCount) : 0;

  // Overtrading
  const overtradeDaysCount = overtradeDays.length;
  const excessTradePnl = overtradeDays.reduce((sum, d) => sum + d.pnl, 0);

  // Rules violations
  const violationTrades = trades.filter(
    (t) => t.brokenRules && t.brokenRules.length > 0
  );
  const rulesCount = violationTrades.length;
  const rulesTotalPnl = violationTrades.reduce((sum, t) => sum + t.pnl, 0);

  // Total emotional cost: only count negative costs
  const totalEmotionalCost = round2(
    Math.min(0, revengeTotalPnl) +
      Math.min(0, excessTradePnl) +
      Math.min(0, rulesTotalPnl)
  );

  return {
    revengeTrading: {
      count: revengeCount,
      totalPnl: round2(revengeTotalPnl),
      avgPnl: revengeAvgPnl,
    },
    overtrading: {
      daysCount: overtradeDaysCount,
      excessTradePnl: round2(excessTradePnl),
    },
    rulesViolations: {
      count: rulesCount,
      totalPnl: round2(rulesTotalPnl),
    },
    totalEmotionalCost,
  };
}
