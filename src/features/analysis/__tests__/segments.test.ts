import { describe, expect, it } from 'vitest';
import { tradeFacts } from '../facts';
import { dimensionValues, segmentTables } from '../segments';
import { DIMENSIONS, type Dimension } from '../types';
import { at, row } from './build';

const full = row({
  id: 'f', ...at('2026-03-05', '14:20', 45), symbol: ' banknifty ', setupType: 'Breakout', tradingSession: 'Morning', side: 'SELL',
  assetClass: 'options', marketCondition: 'Trending', newsEvents: ['RBI policy', 'CPI'], tags: ['A+', 'a+', 'scalp'],
  entryPrice: 100, stopLoss: 105, takeProfit: 88, exitPrice: 90, optionType: 'put', expiry: '2026-03-05',
});

describe('dimensions', () => {
  it('every one of the 15 dimensions has a key for a fully filled trade', () => {
    const f = tradeFacts([full], 'Asia/Kolkata')[0];
    const got = Object.fromEntries(DIMENSIONS.map((d) => [d, dimensionValues(f, d).map((v) => v.key)])) as Record<Dimension, string[]>;
    expect(got).toEqual({
      symbol: ['banknifty'], setup: ['breakout'], session: ['morning'], direction: ['short'], assetClass: ['options'],
      weekday: ['thu'], hour: ['19'], marketCondition: ['trending'], newsEvent: ['rbi policy', 'cpi'], tag: ['a+', 'scalp'],
      plannedRR: ['2-3'], holding: ['30m-2h'], tradeNumber: ['1'], optionType: ['put'], expiryDay: ['expiry-day'],
    });
    expect(dimensionValues(f, 'symbol')[0].name).toBe('banknifty');
    expect(dimensionValues(f, 'hour')[0].name).toBe('19:00-20:00');
  });

  it('a bare trade has no segment in the optional dimensions', () => {
    const f = tradeFacts([row({ id: 'b', openDate: '2026-03-05' })], 'UTC')[0];
    for (const d of ['setup', 'session', 'assetClass', 'hour', 'marketCondition', 'newsEvent', 'tag', 'plannedRR', 'holding', 'optionType', 'expiryDay'] as Dimension[]) {
      expect(dimensionValues(f, d)).toEqual([]);
    }
  });

  it('ordered dimensions keep their natural order; the rest are ranked by evidence then size', () => {
    const rows = [
      row({ id: 'a', ...at('2026-03-06', '09:00', 10), symbol: 'X' }), row({ id: 'b', ...at('2026-03-02', '09:00', 10), symbol: 'Y' }),
      row({ id: 'c', ...at('2026-03-03', '09:00', 10), symbol: 'Y' }),
    ];
    const { segments, tradesPerDay } = segmentTables(tradeFacts(rows, 'UTC'));
    expect(segments.weekday.map((s) => s.key)).toEqual(['mon', 'tue', 'fri']);
    expect(segments.symbol.map((s) => s.key)).toEqual(['y', 'x']);
    expect(tradesPerDay).toEqual([expect.objectContaining({ key: '1', trades: 3, days: 3 })]);
  });
});

describe('segment evidence', () => {
  const rows = Array.from({ length: 80 }, (_, i) => {
    const good = i % 2 === 0;
    return row({ id: `s${i}`, ...at(new Date(Date.UTC(2026, 0, 1 + i)).toISOString().slice(0, 10), '09:00', 30), symbol: good ? 'GOOD' : 'BAD', exitPrice: good ? 105 + (i % 4) : 95 - (i % 4) });
  });
  const { segments } = segmentTables(tradeFacts(rows, 'UTC'));
  const sym = Object.fromEntries(segments.symbol.map((s) => [s.key, s]));

  it('an edge and a leak with 40 trades each, ranked first', () => {
    expect(sym.good).toMatchObject({ trades: 40, wins: 40, winRate: 1, verdict: 'edge', label: 'provisional' });
    expect(sym.bad).toMatchObject({ trades: 40, wins: 0, verdict: 'leak', profitFactor: 0 });
    expect(sym.good.profitFactor).toBeNull();
    expect(sym.good.winRateRange!.lo).toBeGreaterThan(0.9);
    expect(sym.good.avgRRange!.lo).toBeGreaterThan(1);
    expect(sym.good.tradeIds).toHaveLength(40);
  });

  it('a segment with every trade (no comparison group) stays a pattern to watch', () => {
    expect(segments.direction).toEqual([expect.objectContaining({ key: 'long', trades: 80, verdict: 'watch', label: 'provisional' })]);
  });
});
