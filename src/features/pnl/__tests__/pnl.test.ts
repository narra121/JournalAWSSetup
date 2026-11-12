import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { computePnl, outcomeFromPnl, pipSize, pipValue, round2, type PnlInput } from '../index';

// Must equal the hash pinned in TradeFlow src/lib/pnl/__tests__/pnl.test.ts (same vectors file).
const VECTORS_SHA256 = '83a091169fefcbd552737322cbff48cffd2a4832b9ed69bc0f78df0d261f08e2';

const raw = readFileSync(fileURLToPath(new URL('../vectors.json', import.meta.url)), 'utf8').replace(/\r\n/g, '\n');
const vectors = JSON.parse(raw) as {
  cases: { name: string; input: PnlInput; expected: ReturnType<typeof computePnl> }[];
};

describe('pnl vectors (shared with TradeFlow)', () => {
  it('vectors file is the pinned version', () => {
    expect(createHash('sha256').update(raw).digest('hex')).toBe(VECTORS_SHA256);
  });

  it.each(vectors.cases.map((c) => [c.name, c] as const))('%s', (_name, c) => {
    expect(computePnl(c.input)).toEqual(c.expected);
  });
});

describe('helpers', () => {
  it('round2 never returns negative zero', () => {
    expect(Object.is(round2(-0.001), 0)).toBe(true);
    expect(round2(Number.NaN)).toBe(0);
  });

  it('pip size and value', () => {
    expect(pipSize('EURUSD')).toBe(0.0001);
    expect(pipSize('usdjpy.m')).toBe(0.01);
    expect(pipSize('XAUUSDm')).toBe(0.1);
    expect(pipSize('NIFTY24DEC24000CE')).toBeNull();
    expect(pipValue('EURUSD', 1)).toBe(10);
    expect(pipValue('GBPJPY', 0.5)).toBe(500);
  });

  it('outcome by sign', () => {
    expect(outcomeFromPnl(1)).toBe('TP');
    expect(outcomeFromPnl(-0.01)).toBe('SL');
    expect(outcomeFromPnl(0)).toBe('BREAKEVEN');
  });
});
