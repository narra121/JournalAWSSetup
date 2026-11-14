import { describe, expect, it } from 'vitest';
import { localMinuteOfDay, plannedRR, realisedR, tradeFacts } from '../facts';
import { at, behaviourTrades, row } from './build';

describe('realised R (CONTRACT I2)', () => {
  const base = { side: 'BUY' as const, entryPrice: 100, stopLoss: 95, exitPrice: 110, closeDate: '2026-03-02T10:00:00Z' };
  it('dir × (exit − entry) ÷ |entry − stop|, from prices only', () => {
    expect(realisedR(base)).toBe(2);
    expect(realisedR({ ...base, side: 'SELL', stopLoss: 105, exitPrice: 90 })).toBe(2);
    expect(realisedR({ ...base, side: 'SELL', stopLoss: 105, exitPrice: 108 })).toBeCloseTo(-1.6);
  });
  it('null without a stop, with stop = entry, or a missing price', () => {
    expect(realisedR({ ...base, stopLoss: null })).toBeNull();
    expect(realisedR({ ...base, stopLoss: 0 })).toBeNull();
    expect(realisedR({ ...base, stopLoss: 100 })).toBeNull();
    expect(realisedR({ ...base, entryPrice: 0 })).toBeNull();
    expect(realisedR({ ...base, exitPrice: 0, closeDate: null })).toBeNull();
  });
  it('an option closed at 0 (expired) keeps its R', () => {
    expect(realisedR({ ...base, exitPrice: 0 })).toBe(-20);
  });
  it('quantity and multiplier do not enter it', () => {
    const f = tradeFacts([row({ id: 'a', openDate: '2026-03-02T09:00:00Z', quantity: 3, contractMultiplier: 50, exitPrice: 90, pnl: -1500 })], 'UTC')[0];
    expect(f.r).toBe(-2);
    expect(f.risk).toBe(750);
  });
});

describe('planned R:R', () => {
  it('comes from the take-profit when it lies on the profit side, else the stored ratio', () => {
    const t = { side: 'BUY' as const, entryPrice: 100, stopLoss: 95, takeProfit: 115, riskRewardRatio: 2 };
    expect(plannedRR(t)).toBe(3);
    expect(plannedRR({ ...t, takeProfit: 90 })).toBe(2);
    expect(plannedRR({ ...t, takeProfit: null, riskRewardRatio: null })).toBeNull();
    expect(plannedRR({ ...t, side: 'SELL', stopLoss: 105, takeProfit: 90 })).toBe(2);
  });
});

describe('sequence facts (D4)', () => {
  const fs = tradeFacts(behaviourTrades(), 'UTC');
  const by = Object.fromEntries(fs.map((f) => [f.t.id, f]));
  it('trade number in the day and day size', () => {
    expect(fs.map((f) => f.tradeNumber)).toEqual([1, 2, 3, 1, 2, 1, 2, 3, 4, 5, 1, 1]);
    expect(by.t8.dayTrades).toBe(5);
  });
  it('previous result: the latest trade closed before the open, with minutes since its close', () => {
    expect(by.t1.prev).toBeNull();
    expect(by.t2.prev).toEqual({ id: 't1', pnl: -200, sameDay: true, minutesSinceClose: 10 });
    expect(by.t6.prev).toMatchObject({ id: 't5', sameDay: false });
  });
  it('a trade still open when the next one opens is not its previous result', () => {
    const rows = [
      row({ id: 'x', ...at('2026-03-02', '09:00', 120), exitPrice: 90 }),
      row({ id: 'y', ...at('2026-03-02', '09:30', 10), exitPrice: 105 }),
      row({ id: 'z', ...at('2026-03-02', '11:30', 10), exitPrice: 105 }),
    ];
    const f = tradeFacts(rows, 'UTC');
    expect(f[1].prev).toBeNull();
    expect(f[2].prev?.id).toBe('x');
  });
  it('risk against the median risk of the period', () => {
    expect(by.t2.riskVsMedian).toBe(7.5);
    expect(by.t5.riskVsMedian).toBeNull();
  });
});

describe('time zones', () => {
  it('a date-only open date is its own day, with no hour or holding time', () => {
    const f = tradeFacts([row({ id: 'd', openDate: '2026-03-04', closeDate: '2026-03-04' })], 'America/New_York')[0];
    expect(f).toMatchObject({ day: '2026-03-04', weekday: 3, hour: null, minuteOfDay: null, holdingMin: null });
  });
  it('hours follow daylight saving: 09:30 New York before and after the switch on 2026-03-08', () => {
    const [before, after] = tradeFacts([row({ id: 'b', openDate: '2026-03-06T14:30:00.000Z' }), row({ id: 'a', openDate: '2026-03-09T13:30:00.000Z' })], 'America/New_York');
    expect([before.hour, before.minuteOfDay]).toEqual([9, 570]);
    expect([after.hour, after.minuteOfDay]).toEqual([9, 570]);
  });
  it('the local day can differ from the UTC day', () => {
    const f = tradeFacts([row({ id: 'n', openDate: '2026-03-09T03:30:00.000Z' })], 'America/New_York')[0];
    expect(f).toMatchObject({ day: '2026-03-08', weekday: 0, hour: 23 });
    const ist = tradeFacts([row({ id: 'i', openDate: '2026-03-31T20:30:00.000Z' })], 'Asia/Kolkata')[0];
    expect(ist).toMatchObject({ day: '2026-04-01', hour: 2, minuteOfDay: 120 });
  });
  it('UTC needs no conversion', () => {
    expect(localMinuteOfDay(Date.parse('2026-03-02T23:59:00Z'), 'UTC')).toBe(1439);
  });
});
