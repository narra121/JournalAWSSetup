import { describe, expect, it } from 'vitest';
import { bootstrapMean, criticalValue, normalQuantile, prng, sampleLabel, verdict, welchT, wilson } from '../evidence';

describe('sample labels', () => {
  it('follows the report §3.3 bands', () => {
    expect([0, 19, 20, 29, 30, 99, 100, 5000].map(sampleLabel)).toEqual(['too-few', 'too-few', 'early', 'early', 'provisional', 'provisional', 'established', 'established']);
  });
});

describe('wilson', () => {
  it('matches the report: 24 wins of 45 is 39.1% to 67.1%', () => {
    const r = wilson(24, 45);
    expect(r.lo).toBeCloseTo(0.391, 3);
    expect(r.hi).toBeCloseTo(0.671, 3);
  });
  it('stays inside [0, 1] at the edges and is [0, 1] with no trades', () => {
    expect(wilson(0, 10).lo).toBe(0);
    expect(wilson(10, 10).hi).toBe(1);
    expect(wilson(0, 0)).toEqual({ lo: 0, hi: 1 });
  });
});

describe('bootstrapMean', () => {
  const xs = Array.from({ length: 40 }, (_, i) => (i % 4) - 1);
  it('is null below 20 values', () => {
    expect(bootstrapMean(xs.slice(0, 19))).toBeNull();
    expect(bootstrapMean(xs.slice(0, 20))).not.toBeNull();
  });
  it('is deterministic for a seed and brackets the mean', () => {
    const a = bootstrapMean(xs, { iterations: 2000, seed: 7 })!;
    expect(bootstrapMean(xs, { iterations: 2000, seed: 7 })).toEqual(a);
    expect(a.lo).toBeLessThan(0.5);
    expect(a.hi).toBeGreaterThan(0.5);
    expect(bootstrapMean(xs, { seed: 8 })).not.toEqual(a);
  });
  it('the PRNG repeats its sequence', () => {
    const r1 = prng(3), r2 = prng(3);
    expect([r1(), r1(), r1()]).toEqual([r2(), r2(), r2()]);
  });
});

describe('critical values (Bonferroni, two-sided, α = 0.05)', () => {
  it('match the report: about 2.6 for 6, 3.2 for 35; 1.96 for one test', () => {
    expect(criticalValue(1)).toBeCloseTo(1.96, 2);
    expect(criticalValue(6)).toBeCloseTo(2.64, 2);
    expect(criticalValue(35)).toBeCloseTo(3.19, 2);
    expect(criticalValue(13)).toBeCloseTo(2.89, 2);
    expect(normalQuantile(0.975)).toBeCloseTo(1.959964, 5);
    expect(normalQuantile(0.001)).toBeCloseTo(-3.090232, 5);
  });
});

describe('verdict', () => {
  const noise = (n: number, centre: number, seed: number) => {
    const r = prng(seed);
    return Array.from({ length: n }, () => centre + (r() - 0.5));
  };
  it('edge: 30+ each side, a clear positive difference in both halves', () => {
    expect(verdict({ a: noise(40, 1, 1), b: noise(40, 0, 2), candidates: 13 })).toBe('edge');
  });
  it('leak: the same, negative', () => {
    expect(verdict({ a: noise(40, -1, 3), b: noise(40, 0, 4), candidates: 13 })).toBe('leak');
  });
  it('watch below 30 in either group, however large the difference', () => {
    expect(verdict({ a: noise(29, 5, 5), b: noise(40, 0, 6), candidates: 1 })).toBe('watch');
    expect(verdict({ a: noise(40, 5, 5), b: noise(29, 0, 6), candidates: 1 })).toBe('watch');
  });
  it('watch when |t| clears 1.96 but not the threshold for 35 candidates', () => {
    const a = noise(40, 0.13, 7), b = noise(40, 0, 8);
    const t = Math.abs(welchT(a, b));
    expect(t).toBeGreaterThan(1.96);
    expect(t).toBeLessThan(criticalValue(35));
    expect(verdict({ a, b, candidates: 1 })).not.toBe('watch');
    expect(verdict({ a, b, candidates: 35 })).toBe('watch');
  });
  it('watch when the sign flips between the first and second half of a (by time)', () => {
    // overall far above b, but the older half is below it
    const a = [...noise(20, -0.5, 9), ...noise(20, 3.5, 10)];
    const b = noise(40, 0, 11);
    expect(Math.abs(welchT(a, b))).toBeGreaterThan(criticalValue(13));
    expect(verdict({ a, b, candidates: 13 })).toBe('watch');
    // with the older half above b as well
    expect(verdict({ a: [...noise(20, 1, 9), ...noise(20, 3.5, 10)], b, candidates: 13 })).toBe('edge');
  });
});
