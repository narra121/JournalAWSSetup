import type { Range, SampleLabel, Verdict } from './types';

/** Evidence rules of the research report §3.3 (CONTRACT I3). Mirrored by TradeFlow src/lib/evidence.ts: change both. */

export const MIN_RANGE_TRADES = 20;
export const MIN_VERDICT_TRADES = 30;
const ALPHA = 0.05;
const Z95 = 1.959963984540054;

export function sampleLabel(n: number): SampleLabel {
  if (n < 20) return 'too-few';
  if (n < 30) return 'early';
  if (n < 100) return 'provisional';
  return 'established';
}

/** Wilson score interval (95%) of k successes in n; [0, 1] when n is 0. */
export function wilson(k: number, n: number): Range {
  if (n <= 0) return { lo: 0, hi: 1 };
  const p = k / n;
  const z2 = Z95 * Z95;
  const centre = (p + z2 / (2 * n)) / (1 + z2 / n);
  const half = (Z95 * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / (1 + z2 / n);
  return { lo: k <= 0 ? 0 : Math.max(0, centre - half), hi: k >= n ? 1 : Math.min(1, centre + half) };
}

/** Deterministic PRNG (mulberry32): the same seed gives the same sequence on every platform. */
export function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const DEFAULT_SEED = 20261113;

/** Percentile bootstrap (95%) of the mean; null below 20 values. */
export function bootstrapMean(xs: number[], opts: { iterations?: number; seed?: number } = {}): Range | null {
  const n = xs.length;
  if (n < MIN_RANGE_TRADES) return null;
  const iterations = opts.iterations ?? 2000;
  const rand = prng(opts.seed ?? DEFAULT_SEED);
  const means = new Float64Array(iterations);
  for (let i = 0; i < iterations; i++) {
    let s = 0;
    for (let j = 0; j < n; j++) s += xs[Math.floor(rand() * n)];
    means[i] = s / n;
  }
  means.sort();
  return { lo: means[Math.floor(0.025 * iterations)], hi: means[Math.min(iterations - 1, Math.floor(0.975 * iterations))] };
}

export const mean = (xs: number[]): number | null => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : null);

/** Sample variance (n − 1); 0 for fewer than 2 values. */
export function variance(xs: number[]): number {
  if (xs.length < 2) return 0;
  const m = mean(xs)!;
  return xs.reduce((s, x) => s + (x - m) ** 2, 0) / (xs.length - 1);
}

/** Welch's t statistic of mean(a) − mean(b); ±Infinity when both groups are constant and differ. */
export function welchT(a: number[], b: number[]): number {
  const diff = mean(a)! - mean(b)!;
  const se = Math.sqrt(variance(a) / a.length + variance(b) / b.length);
  if (se === 0) return diff === 0 ? 0 : diff > 0 ? Infinity : -Infinity;
  return diff / se;
}

/** Inverse of the standard normal CDF (Acklam's rational approximation, relative error < 1.2e-9). */
export function normalQuantile(p: number): number {
  if (p <= 0) return -Infinity;
  if (p >= 1) return Infinity;
  const a = [-39.69683028665376, 220.9460984245205, -275.9285104469687, 138.357751867269, -30.66479806614716, 2.506628277459239];
  const b = [-54.47609879822406, 161.5858368580409, -155.6989798598866, 66.80131188771972, -13.28068155288572];
  const c = [-0.007784894002430293, -0.3223964580411365, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [0.007784695709041462, 0.3224671290700398, 2.445134137142996, 3.754408661907416];
  const lowTail = 0.02425;
  if (p < lowTail) {
    const q = Math.sqrt(-2 * Math.log(p));
    return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  if (p > 1 - lowTail) return -normalQuantile(1 - p);
  const q = p - 0.5;
  const r = q * q;
  return ((((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q) / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
}

/** Two-sided Bonferroni critical value at α = 0.05 for `candidates` tests (normal approximation): 2.64 for 6, 3.19 for 35. */
export const criticalValue = (candidates: number): number => normalQuantile(1 - ALPHA / (2 * Math.max(1, candidates)));

/**
 * 'edge' (a is better) or 'leak' (a is worse) only with 30+ values in each group, a Welch |t| at or above the Bonferroni
 * critical value for `candidates`, and the same sign of mean(half of a) − mean(b) in the first and the second half of a.
 * Both arrays must be in time order (oldest first).
 */
export function verdict(input: { a: number[]; b: number[]; candidates: number }): Verdict {
  const { a, b, candidates } = input;
  if (a.length < MIN_VERDICT_TRADES || b.length < MIN_VERDICT_TRADES) return 'watch';
  const t = welchT(a, b);
  if (!(Math.abs(t) >= criticalValue(candidates))) return 'watch';
  const mb = mean(b)!;
  const half = Math.floor(a.length / 2);
  const first = Math.sign(mean(a.slice(0, half))! - mb);
  const second = Math.sign(mean(a.slice(half))! - mb);
  if (first === 0 || first !== second || first !== Math.sign(t)) return 'watch';
  return t > 0 ? 'edge' : 'leak';
}
