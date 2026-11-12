import type { AggregatedStats } from './metrics/types';

export interface AdvancedStats {
  rDistribution: { buckets: { label: string; count: number }[]; noStop: number };
  drawdownCurve: { date: string; equity: number; peak: number; drawdown: number; drawdownPct: number | null }[];
  strategyExpectancy: Record<string, { trades: number; expectancy: number; avgR: number | null }>;
}

/**
 * `?sections=advanced` payload: realized-R histogram, drawdown curve from the daily equity curve, and per-strategy
 * expectancy (net per trade) with average R. `startingCapital` (optional) turns drawdown into a percentage.
 */
export function buildAdvancedStats(stats: AggregatedStats, startingCapital?: number): AdvancedStats {
  const capital = startingCapital && startingCapital > 0 ? startingCapital : 0;
  let peak = capital;
  const drawdownCurve = (stats.dailyPnl ?? []).map((d) => {
    const equity = capital + d.cumulativePnl;
    if (equity > peak) peak = equity;
    const drawdown = peak - equity;
    return { date: d.date, equity, peak, drawdown, drawdownPct: peak > 0 ? (drawdown / peak) * 100 : null };
  });

  const strategies = (stats.segments?.strategy ?? {}) as Record<string, { trades: number; net: number; avgR: number | null }>;
  const strategyExpectancy = Object.fromEntries(
    Object.entries(strategies).map(([name, s]) => [name, { trades: s.trades, expectancy: s.trades > 0 ? s.net / s.trades : 0, avgR: s.avgR }]),
  );

  return {
    rDistribution: stats.rDistribution ?? { buckets: [], noStop: 0 },
    drawdownCurve,
    strategyExpectancy,
  };
}
