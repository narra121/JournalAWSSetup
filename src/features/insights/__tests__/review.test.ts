import { describe, expect, it } from 'vitest';
import { qaTrades } from '../../analysis/__tests__/build';
import type { TradeRow } from '../../trades-repo';
import type { HistoryRow } from '../history';
import type { ReviewFinding } from '../types';
import { reviewOf, rTrade, tr } from './fixtures';

/**
 * Week 2026-10-05..11 (UTC), risk 50 a trade, net −380:
 * b1 −2R, b2 −1.6R (past the stop: 50 + 30 beyond); n1 −300, n2 +50 (no stop); k1, k2 −1R (broke rule r1; k2 also tagged FOMO);
 * w1 +2R, w2 +1R.
 */
function week(): TradeRow[] {
  return [
    rTrade('b1', '2026-10-05', '09:00', -2),
    rTrade('b2', '2026-10-05', '11:00', -1.6),
    tr('n1', '2026-10-06', '09:00', { stopLoss: null, exitPrice: 70, quantity: 10 }),
    tr('n2', '2026-10-06', '10:00', { stopLoss: null, exitPrice: 105, quantity: 10 }),
    rTrade('k1', '2026-10-07', '09:00', -1, { brokenRuleIds: ['week#2026-10-05#a'] }),
    rTrade('k2', '2026-10-07', '12:00', -1, { brokenRuleIds: ['week#2026-10-05#a'], mistakes: ['FOMO'] }),
    rTrade('w1', '2026-10-08', '09:00', 2),
    rTrade('w2', '2026-10-09', '09:00', 1),
  ];
}
const RULES = new Map([['week#2026-10-05#a', 'No trade after a loss']]);
const findings = (r: ReturnType<typeof reviewOf>['review']) => [r.theOne, ...r.more].filter((f): f is ReviewFinding => f != null);

describe('findings: costed, merged by cause, each trade once', () => {
  const r = reviewOf(week(), { ruleTexts: RULES }).review;

  it('ranks the costed behaviours by money and attributes each trade to one of them', () => {
    expect(findings(r).map((f) => [f.key, f.cost, f.trades])).toEqual([
      ['detector:noStop', 250, 2],
      ['rule:no trade after a loss', 100, 2],
      ['detector:beyondStop', 80, 2],
    ]);
    const ids = findings(r).flatMap((f) => f.tradeIds);
    expect(new Set(ids).size).toBe(ids.length);
    expect(r.theOne).toMatchObject({ basis: 'accounting', rule: { kind: 'setStop' }, ruleText: "If I can't say where my stop is, I don't enter." });
  });

  it('merges a tag that is the same trades into the finding that holds them, so its money is not counted twice', () => {
    const rule = r.more[0];
    expect(rule.overlaps).toEqual([{ key: 'mistake:fomo', title: 'Tagged "FOMO"', shared: 1 }]);
    expect(r.watch.map((w) => w.key)).not.toContain('mistake:fomo');
  });

  it('beyond the stop costs only the part past the stop, in money and R, and replays the period with every loss at the stop', () => {
    const b = r.more[1];
    expect(b).toMatchObject({ cost: 80, costR: 1.6, net: -180, replay: { actualNet: -380, replayNet: -300, removed: 0 } });
    expect(b.text).toContain('2 of 5 losing trades went past the stop; the part beyond the stop cost ₹80.00 (1.60R)');
  });

  it('the costs never add up to more than the money lost (QA accounts, both currencies)', () => {
    for (const cur of ['INR', 'USD'] as const) {
      const trades = qaTrades(cur);
      const rv = reviewOf(trades, { currency: cur, period: { from: '2026-08-01', to: '2026-11-10' }, timeZone: 'Asia/Kolkata' }).review;
      const fs = findings(rv);
      const ids = fs.flatMap((f) => f.tradeIds);
      expect(new Set(ids).size).toBe(ids.length);
      const lost = trades.filter((t) => t.pnl < 0).reduce((s, t) => s - t.pnl, 0);
      expect(fs.reduce((s, f) => s + f.cost, 0)).toBeLessThanOrEqual(lost + 0.01);
    }
  });

  it('the INR account of report §5.2: one cause (beyond the stop), its price, the if-then rule, and Fridays/NIFTY as one pattern', () => {
    const rv = reviewOf(qaTrades('INR'), { currency: 'INR', period: { from: '2026-08-10', to: '2026-11-04' }, timeZone: 'Asia/Kolkata' }).review;
    expect(rv.theOne).toMatchObject({ key: 'detector:beyondStop', trades: 11, cost: 26382.89, ruleText: 'If price reaches my stop, I exit.', replay: { actualNet: -56787.78, replayNet: -30404.89 } });
    expect(rv.theOne!.text).toContain('11 of 17 losing trades went past the stop');
    expect(rv.verdict).toMatchObject({ result: 'losing', net: -56787.78, headline: 'A losing period, partly self-inflicted.' });
    const fri = rv.watch.find((w) => w.key === 'segment:weekday:fri')!;
    expect(fri).toMatchObject({ trades: 7, wins: 0, label: 'too-few' });
    expect(fri.overlaps).toContainEqual({ key: 'segment:symbol:nifty', title: 'NIFTY', shared: 4 });
    const moved = rv.watch.find((w) => w.key === 'mistake:moved stop loss')!;
    expect(moved).toMatchObject({ trades: 4, net: 1406.25, paidSoFar: true });
    expect(moved.text).toContain('It has paid so far; that is not evidence that it works.');
  });

  it('a muted key is left out and the next cause takes its trades', () => {
    const m = reviewOf(week(), { ruleTexts: RULES, muted: new Set(['detector:noStop']) }).review;
    expect(m.theOne!.key).toBe('rule:no trade after a loss');
    expect(m.muted).toEqual(['detector:noStop']);
    expect(findings(m).map((f) => f.key)).not.toContain('detector:noStop');
  });

  it('counts one rule stored per period as one rule, whichever period id a trade holds (rules grouped by text)', () => {
    const ids = ['week#2026-10-05#a', 'week#2026-10-12#b'];
    const texts = new Map([[ids[0], 'No FOMO'], [ids[1], 'no  fomo ']]);
    const t = week().map((x) => (x.id === 'k1' ? { ...x, brokenRuleIds: [ids[0]] } : x.id === 'k2' ? { ...x, brokenRuleIds: [ids[1]] } : x));
    const rule = findings(reviewOf(t, { ruleTexts: texts }).review).find((f) => f.source === 'rule')!;
    expect(rule).toMatchObject({ key: 'rule:no fomo', title: 'Broke "No FOMO"', trades: 2, ruleText: 'If a trade would break my rule "No FOMO", I skip it.' });
  });
});

describe('verdict: process apart from result', () => {
  it('a losing week that the process breaks account for', () => {
    expect(reviewOf(week(), { ruleTexts: RULES }).review.verdict).toMatchObject({
      result: 'losing', process: 'poor', net: -380, netR: -2.6, tradesWithR: 6, cleanShare: 0.25, stopShare: 0.75, keptToStopShare: 0.5,
      selfInflictedShare: 1, headline: 'A losing week, mostly self-inflicted.',
    });
  });

  it('a losing week played well, and a winning week that one trade made', () => {
    const clean = [-1, -1, 1, -1, -1].map((r, i) => rTrade(`c${i}`, `2026-10-0${5 + i}`, '09:00', r));
    expect(reviewOf(clean).review.verdict.headline).toBe('A losing week, played well.');
    const lucky = [-1, -1, 6, -1, -1].map((r, i) => rTrade(`l${i}`, `2026-10-0${5 + i}`, '09:00', r));
    expect(reviewOf(lucky).review.verdict).toMatchObject({ result: 'winning', headline: 'A winning week, but one trade made it.' });
  });

  it('a month is a "period", and a week without a stop is judged on money', () => {
    const t = [1, -2, 3, 1, 1].map((x, i) => tr(`m${i}`, `2026-10-0${5 + i}`, '09:00', { stopLoss: null, exitPrice: 100 + x, quantity: 10 }));
    const v = reviewOf(t, { period: { from: '2026-10-01', to: '2026-10-31' } }).review.verdict;
    expect(v).toMatchObject({ result: 'winning', netR: null, tradesWithR: 0, process: 'poor' });
    expect(v.headline).toMatch(/^A winning period/);
  });
});

describe('evidence: patterns, strengths and the 90-day baseline', () => {
  // Baseline: 40 days with a Breakout (+1R) and a Pullback (−1R) trade, alternating which comes first; the week repeats it.
  const day = (base: string, n: number) => new Date(Date.parse(`${base}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
  const pair = (d: string, i: number, pre: string) => {
    const [a, b] = i % 2 ? ['09:00', '13:00'] : ['13:00', '09:00'];
    return [rTrade(`${pre}b${i}`, d, a, 1, { setupType: 'Breakout' }), rTrade(`${pre}p${i}`, d, b, -1, { setupType: 'Pullback' })];
  };
  const baseline = Array.from({ length: 40 }, (_, i) => pair(day('2026-08-20', i), i, 'x')).flat();
  const period = Array.from({ length: 4 }, (_, i) => pair(day('2026-10-05', i), i, 'y')).flat();
  const r = reviewOf(period, { baseline }).review;

  it('a segment that passes the evidence rule as a leak becomes a costed finding with a skip rule', () => {
    expect(r.theOne).toMatchObject({ key: 'segment:setup:pullback', basis: 'evidence', verdict: 'leak', trades: 4, cost: 200, evidenceTrades: 44, rule: { kind: 'skipSegment', dimension: 'setup', key: 'pullback' } });
    expect(r.theOne!.ruleText).toBe('If the setup is Pullback, I skip it.');
    expect(r.theOne!.text).toContain('it covers 44 trades: −1.00R a trade against +1.00R for the rest, which passes the evidence rule.');
    expect(r.baseline).toEqual({ from: '2026-07-07', to: '2026-10-04', trades: 80 });
  });

  it('keep doing: the strength that passes the rule, with its range', () => {
    expect(r.keepDoing).toMatchObject({ key: 'segment:setup:breakout', trades: 44, periodTrades: 4, winRate: 1, avgR: 1, label: 'provisional' });
  });

  it('without the baseline nothing passes: no keep-doing, and the slices are only watched', () => {
    const alone = reviewOf(period).review;
    expect(alone.keepDoing).toBeUndefined();
    expect(alone.theOne).toBeNull();
    expect(alone.watch.map((w) => w.key)).toContain('segment:setup:pullback');
    expect(alone.watch.find((w) => w.key === 'segment:setup:pullback')!.text).toContain('too few to call it');
  });
});

describe('different from your normal (12 weeks)', () => {
  it('flags only measures outside every one of the last 12 weeks', () => {
    const baseline: TradeRow[] = [];
    for (let w = 1; w <= 12; w++) {
      for (let d = 0; d < 5; d++) {
        const day = new Date(Date.parse('2026-10-05T00:00:00Z') - (7 * w - d) * 86_400_000).toISOString().slice(0, 10);
        baseline.push(rTrade(`h${w}-${d}`, day, '09:00', d % 2 ? 1 : -0.5));
      }
    }
    // Same average R (+0.10R) and win rate (40%) as every baseline week, three times the trades a day.
    const period = Array.from({ length: 15 }, (_, i) => rTrade(`p${i}`, `2026-10-0${5 + Math.floor(i / 3)}`, `${10 + (i % 3)}:00`, (i % 5) % 2 ? 1 : -0.5));
    const d = reviewOf(period, { baseline }).review.different;
    expect(d.map((x) => x.measure)).toEqual(['tradesPerDay']);
    expect(d[0]).toMatchObject({ key: 'different:tradesPerDay', value: 3, normalLo: 1, normalHi: 1, weeks: 12, direction: 'above' });
    expect(d[0].text).toBe('Trades per trading day: 3.0, higher than in any of your last 12 weeks with trades (1.0 to 1.0).');
  });

  it('says nothing with fewer than 6 weeks of history', () => {
    expect(reviewOf(week()).review.different).toEqual([]);
  });
});

describe('last week focus, kept or broken', () => {
  it('exit at the stop: losing trades with a stop are checked, the breaks cost the part beyond the stop', () => {
    const focus = { rule: { kind: 'exitAtStop' as const }, text: 'If price reaches my stop, I exit.', startedAt: '2026-10-05T00:00:00.000Z', findingKey: 'detector:beyondStop' };
    expect(reviewOf(week(), { focus }).review.lastFocus).toMatchObject({ checked: 4, kept: 2, broken: 2, brokenTradeIds: ['b1', 'b2'], cost: 80, brokenNet: -180 });
  });

  it('a daily cap: second trades break it; the verdict shows the share inside the cap; trades before the start are not checked', () => {
    const focus = { rule: { kind: 'maxTradesPerDay' as const, n: 1 }, text: 'If I have taken one trade today, I stop for the day.', startedAt: '2026-10-06T00:00:00.000Z', findingKey: null };
    const r = reviewOf(week(), { focus }).review;
    expect(r.lastFocus).toMatchObject({ checked: 6, kept: 4, broken: 2, brokenTradeIds: ['n2', 'k2'], brokenNet: 0, cost: 0 });
    expect(r.verdict.insideCapShare).toBe(0.625); // 5 first trades of 8 in the week
  });

  it('a focus started after the period is not reported', () => {
    const focus = { rule: { kind: 'setStop' as const }, text: 't', startedAt: '2026-10-20T00:00:00.000Z', findingKey: null };
    expect(reviewOf(week(), { focus }).review.lastFocus).toBeUndefined();
  });

  it('uses the trader\'s time zone for the day: 18:00 and 19:00 UTC are one day in UTC, two in Kolkata', () => {
    const t = [rTrade('a', '2026-10-06', '18:00', 1), rTrade('b', '2026-10-06', '19:00', 1), ...['08', '09', '10'].map((d) => rTrade(`c${d}`, `2026-10-${d}`, '09:00', 1))];
    const focus = { rule: { kind: 'maxTradesPerDay' as const, n: 1 }, text: 'cap', startedAt: '2026-10-05T00:00:00.000Z', findingKey: null };
    expect(reviewOf(t, { focus, timeZone: 'UTC' }).review.lastFocus!.broken).toBe(1);
    expect(reviewOf(t, { focus, timeZone: 'Asia/Kolkata' }).review.lastFocus!.broken).toBe(0);
  });
});

describe('memory of findings', () => {
  const rowAt = (weekStart: string, key: string, count: number, shown = true): HistoryRow => ({ weekStart, key, title: key, count, net: -1, avgR: null, shown });

  it('third week in a row, down from 7 to 2; a finding shown last week with no trades now is resolved', () => {
    const history = [rowAt('2026-09-28', 'detector:noStop', 7), rowAt('2026-09-21', 'detector:noStop', 3), rowAt('2026-09-28', 'detector:reentryAfterLoss', 2), rowAt('2026-09-28', 'detector:fees', 3, false)];
    const r = reviewOf(week(), { history, ruleTexts: RULES }).review;
    expect(r.theOne!.history).toEqual({ weeksInRow: 3, lastWeekCount: 7, status: 'down' });
    expect(r.theOne!.text).toContain('Third week in a row, down from 7 trades last week to 2.');
    expect(r.more[0].history).toEqual({ weeksInRow: 1, lastWeekCount: null, status: 'new' });
    expect(r.resolved).toEqual([{ key: 'detector:reentryAfterLoss', title: 'detector:reentryAfterLoss', lastWeekCount: 2 }]);
  });

  it('rows to store: every behaviour with trades this week, the shown flag on the findings', () => {
    const c = reviewOf(week(), { ruleTexts: RULES });
    expect(c.weekStart).toBe('2026-10-05');
    const byKey = new Map(c.historyRows.map((h) => [h.key, h]));
    expect(byKey.get('detector:noStop')).toMatchObject({ count: 2, net: -250, shown: true });
    expect(byKey.get('mistake:fomo')).toMatchObject({ count: 1, shown: false });
    expect([...byKey.keys()].filter((k) => k.startsWith('segment:'))).toEqual(c.review.watch.filter((w) => w.source === 'segment').map((w) => w.key));
  });
});

describe('notes are opt-in', () => {
  const t = week().map((x, i) => ({ ...x, notes: i < 2 ? `entered late ${i}` : null, lessons: i === 6 ? ['Waited for the close'] : [] }));
  it('off: nothing of the notes is computed or sent, and the block is absent', () => {
    const c = reviewOf(t);
    expect(c.notes).toBeNull();
    expect(c.review.fromNotes).toBeUndefined();
  });
  it('on: notes and lessons of the period, worst and best first, and an empty block for the model to fill', () => {
    const c = reviewOf(t, { useNotes: true });
    expect(c.notes!.map((n) => [n.id, n.result])).toEqual([['b1', 'loss'], ['w1', 'win'], ['b2', 'loss']]);
    expect(c.notes![1].lessons).toEqual(['Waited for the close']);
    expect(c.review.fromNotes).toEqual([]);
    expect(c.hash).not.toBe(reviewOf(t).hash);
  });
});

describe('deterministic', () => {
  it('same input, same hash; a different focus changes it', () => {
    expect(reviewOf(week()).hash).toBe(reviewOf(week()).hash);
    const focus = { rule: { kind: 'setStop' as const }, text: 't', startedAt: '2026-10-05T00:00:00.000Z', findingKey: null };
    expect(reviewOf(week(), { focus }).hash).not.toBe(reviewOf(week()).hash);
  });

  it('an empty period gives an empty review without throwing', () => {
    const r = reviewOf([]).review;
    expect(r).toMatchObject({ theOne: null, more: [], watch: [], different: [], verdict: { result: 'flat', net: 0, netR: null } });
  });
});
