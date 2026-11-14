import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { computePnl, outcomeFromPnl, pipSize, round2, type PnlInput } from '../index';

// Must equal the hash pinned in TradeFlow src/lib/pnl/__tests__/pnl.test.ts (same vectors file).
const VECTORS_SHA256 = 'b712a25dab08805ca8dfa716e73d86f7eb15dcc51a768748abc09f74ec384352';

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

  it('pip size', () => {
    expect(pipSize('EURUSD')).toBe(0.0001);
    expect(pipSize('usdjpy.m')).toBe(0.01);
    expect(pipSize('XAUUSDm')).toBe(0.1);
    expect(pipSize('NIFTY24DEC24000CE')).toBeNull();
  });

  it('outcome by sign', () => {
    expect(outcomeFromPnl(1)).toBe('TP');
    expect(outcomeFromPnl(-0.01)).toBe('SL');
    expect(outcomeFromPnl(0)).toBe('BREAKEVEN');
  });
});
