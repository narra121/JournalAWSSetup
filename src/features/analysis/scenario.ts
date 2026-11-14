import { prng } from './evidence';
import { round2 } from './segments';
import type { Scenario } from './types';

export const SCENARIO_MIN_TRADES = 50;
export const SCENARIO_RUNS = 5000;
export const SCENARIO_HORIZON = 100;
const SCENARIO_SEED = 100;

/**
 * "If your next 100 trades resemble these": the trades' net P&L resampled with replacement, 5,000 runs from a fixed
 * seed. Null below 50 trades. `deepestSoFar` is the period's deepest drawdown (positive).
 */
export function nextTradesScenario(pnls: number[], opts: { startingBalance?: number | null; deepestSoFar?: number } = {}): Scenario | null {
  const n = pnls.length;
  if (n < SCENARIO_MIN_TRADES) return null;
  const rand = prng(SCENARIO_SEED);
  const balance = opts.startingBalance != null && opts.startingBalance > 0 ? opts.startingBalance : null;
  const ddAmount = balance != null ? 0.05 * balance : opts.deepestSoFar && opts.deepestSoFar > 0 ? opts.deepestSoFar : null;
  const band = balance != null ? 0.1 * balance : null;
  const finals = new Float64Array(SCENARIO_RUNS);
  const drawdowns = new Float64Array(SCENARIO_RUNS);
  let ddHits = 0, targetFirst = 0, limitFirst = 0;
  for (let run = 0; run < SCENARIO_RUNS; run++) {
    let equity = 0, peak = 0, worst = 0;
    let decided = false;
    for (let i = 0; i < SCENARIO_HORIZON; i++) {
      equity += pnls[Math.floor(rand() * n)];
      if (equity > peak) peak = equity;
      if (peak - equity > worst) worst = peak - equity;
      if (band != null && !decided) {
        if (equity <= -band) { limitFirst++; decided = true; }
        else if (equity >= band) { targetFirst++; decided = true; }
      }
    }
    finals[run] = equity;
    drawdowns[run] = worst;
    if (ddAmount != null && worst >= ddAmount) ddHits++;
  }
  finals.sort();
  drawdowns.sort();
  const pct = (xs: Float64Array, p: number) => round2(xs[Math.min(xs.length - 1, Math.floor(p * xs.length))]);
  return {
    basedOn: n,
    runs: SCENARIO_RUNS,
    horizon: SCENARIO_HORIZON,
    profitableShare: finals.filter((v) => v > 0).length / SCENARIO_RUNS,
    final: { p5: pct(finals, 0.05), p50: pct(finals, 0.5), p95: pct(finals, 0.95) },
    maxDrawdown: { p50: pct(drawdowns, 0.5), p95: pct(drawdowns, 0.95) },
    drawdownRisk: ddAmount != null ? { amount: round2(ddAmount), share: ddHits / SCENARIO_RUNS } : null,
    targetBeforeLimit: band != null ? { target: round2(band), limit: round2(-band), targetFirst: targetFirst / SCENARIO_RUNS, limitFirst: limitFirst / SCENARIO_RUNS } : null,
  };
}
