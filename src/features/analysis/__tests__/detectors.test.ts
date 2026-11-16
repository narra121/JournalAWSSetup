import { describe, expect, it } from 'vitest';
import { computeDetectors } from '../detectors';
import { tradeFacts } from '../facts';
import { DETECTOR_IDS, type DetectorId } from '../types';
import { behaviourTrades, row, RULE_TEXTS } from './build';

const detect = (opts: Parameters<typeof computeDetectors>[1] = {}) => {
  const ds = computeDetectors(tradeFacts(behaviourTrades(), 'UTC'), { ruleTexts: RULE_TEXTS, currency: 'INR', ...opts });
  return Object.fromEntries(ds.map((d) => [d.id, d])) as Record<DetectorId, (typeof ds)[number]>;
};

describe('the fixed detector list (report §4.6)', () => {
  it('returns every id once, in the fixed order', () => {
    expect(computeDetectors(tradeFacts(behaviourTrades(), 'UTC')).map((d) => d.id)).toEqual([...DETECTOR_IDS]);
    expect(DETECTOR_IDS).toHaveLength(13);
  });

  it('flags the hand-counted trades of the behaviour fixture', () => {
    const d = detect({ dailyLossLimit: 25 });
    const ids = (id: DetectorId) => d[id].tradeIds;
    expect(ids('reentryAfterLoss')).toEqual(['t2', 't7']);
    expect(ids('afterLoss')).toEqual(['t2', 't5', 't7', 't8', 't9']);
    expect(ids('sizeUpAfterLoss')).toEqual(['t2', 't12']);
    expect(ids('tradeNumber')).toEqual(['t2', 't3', 't5', 't7', 't8', 't9', 't10']);
    expect(ids('overtradingDay')).toEqual(['t6', 't7', 't8', 't9', 't10']);
    expect(ids('beyondStop')).toEqual(['t1', 't4']);
    expect(ids('noStop')).toEqual(['t5']);
    expect(ids('targetNotReached')).toEqual(['t3']);
    expect(ids('losersHeldLonger')).toEqual(['t1', 't4', 't7', 't11']);
    expect(ids('fees')).toEqual(['t6']);
    expect(ids('brokenRule')).toEqual(['t7', 't8']);
    expect(ids('afterDailyLimit')).toEqual(['t2', 't5', 't9', 't10']);
    expect(ids('expiryDay')).toEqual(['t11']);
  });

  it('carries count, net, average R and the comparison group average', () => {
    const d = detect();
    expect(d.beyondStop).toMatchObject({ count: 2, net: -230, avgR: -1.75, label: 'too-few', verdict: 'watch' });
    expect(d.beyondStop.detail).toContain('2 of 6 losing trades');
    expect(d.beyondStop.detail).toContain('₹110.00');
    // after a loss (t2 +1, t7 −0.5, t8 −0.5, t9 +1; t5 has no stop) against after a win (t3 +0.4, t10 +1)
    expect(d.afterLoss).toMatchObject({ count: 5, net: 280, avgR: 0.25, normalAvgR: 0.7 });
    expect(d.sizeUpAfterLoss.detail).toContain('2 of 5 trades');
    expect(d.sizeUpAfterLoss.detail).toContain('₹40.00');
    expect(d.losersHeldLonger.detail).toContain('winners 15 min, losers 25 min');
    expect(d.losersHeldLonger.detail).toContain('4 of 6 losing trades');
    // compared with the other losers: t6 (+0.5R before fees) and t8 (−0.5R)
    expect(d.losersHeldLonger).toMatchObject({ count: 4, avgR: -1.125, normalAvgR: 0 });
    expect(d.overtradingDay.detail).toContain('1 day had more than 2× your usual 2 trades');
    expect(d.brokenRule.detail).toContain('"No revenge trades" 2×');
    expect(d.expiryDay).toMatchObject({ count: 1, net: -50, avgR: -0.5, normalAvgR: 0.4 });
    expect(d.noStop).toMatchObject({ count: 1, net: 10, avgR: null });
    expect(d.fees.detail).toContain('₹6.00');
  });

  it('afterDailyLimit without a limit: count 0 and a note', () => {
    const d = detect();
    expect(d.afterDailyLimit).toMatchObject({ count: 0, tradeIds: [], verdict: 'watch', label: 'too-few' });
    expect(d.afterDailyLimit.detail).toMatch(/No daily loss limit is set/);
  });

  it('zero trades: thirteen empty rows', () => {
    const ds = computeDetectors([]);
    expect(ds).toHaveLength(13);
    for (const x of ds) expect(x).toMatchObject({ count: 0, net: 0, avgR: null, verdict: 'watch', label: 'too-few' });
  });

  it('a behaviour is called a leak once it has 30+ trades each side and survives the split-half check', () => {
    // 40 days: a losing first trade, then a re-entry 5 min later that also loses past the stop; 40 calm days
    const rows = [];
    for (let i = 0; i < 40; i++) {
      const day = new Date(Date.UTC(2026, 0, 1 + i)).toISOString().slice(0, 10);
      rows.push(row({ id: `a${i}`, openDate: `${day}T09:00:00.000Z`, closeDate: `${day}T09:10:00.000Z`, exitPrice: i % 2 ? 97 : 96 }));
      rows.push(row({ id: `b${i}`, openDate: `${day}T09:15:00.000Z`, closeDate: `${day}T09:20:00.000Z`, exitPrice: 90 - (i % 3) }));
    }
    const ds = computeDetectors(tradeFacts(rows, 'UTC'));
    const reentry = ds.find((x) => x.id === 'reentryAfterLoss')!;
    expect(reentry.count).toBe(40);
    expect(reentry.verdict).toBe('leak');
    expect(reentry.label).toBe('provisional');
  });
});
