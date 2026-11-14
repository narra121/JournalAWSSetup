import { describe, expect, it } from 'vitest';
import { qaTrades } from '../../analysis/__tests__/build';
import { buildInsightRequest, INSIGHT_SYSTEM, reviewPayload } from '../prompt';
import type { Review } from '../types';
import { allowedNumbers, numbersIn, onlyKnownNumbers, validateInsight, wording } from '../validate';
import { reviewOf, rTrade } from './fixtures';

describe('numbers in a text', () => {
  it('reads money, R, percentages and counts as written', () => {
    expect(numbersIn('lost −₹26,382.89 (6.10R), 26.1% of 17 trades')).toEqual([
      { value: 26382.89, decimals: 2 }, { value: 6.1, decimals: 2 }, { value: 26.1, decimals: 1 }, { value: 17, decimals: 0 },
    ]);
  });

  it('allows a number from the data, a share of one as a percentage, or one rounded; nothing else', () => {
    const allowed = allowedNumbers({ cost: '₹26,382.89', share: 0.2609, n: 17, key: 'x:999', tradeIds: ['123'] });
    expect(onlyKnownNumbers('₹26,382.89 and 26.1% of 17', allowed)).toBe(true);
    expect(onlyKnownNumbers('about ₹26,383', allowed)).toBe(true);
    expect(onlyKnownNumbers('18 trades', allowed)).toBe(false);
    expect(onlyKnownNumbers('999', allowed)).toBe(false);
    expect(onlyKnownNumbers('123', allowed)).toBe(false);
  });

  it('wording falls back to the code sentence on an unknown number, talk about the person, or market advice', () => {
    const allowed = [17, 11];
    const fb = '11 of 17 losing trades went past the stop.';
    expect(wording('Eleven of your losses ran past the stop: 11 of 17.', fb, 300, allowed)).toBe('Eleven of your losses ran past the stop: 11 of 17.');
    expect(wording('12 of 17 losses ran past the stop.', fb, 300, allowed)).toBe(fb);
    expect(wording('You are an undisciplined trader: 11 of 17.', fb, 300, allowed)).toBe(fb);
    expect(wording('Great job on 11 trades.', fb, 300, allowed)).toBe(fb);
    expect(wording('Sell NIFTY when it will fall.', fb, 300, allowed)).toBe(fb);
    expect(wording('', fb, 300, allowed)).toBe(fb);
    expect(wording(42, fb, 300, allowed)).toBe(fb);
  });
});

describe('the prompt', () => {
  const c = reviewOf([1, -2, 1, -1, 1].map((r, i) => rTrade(`t${i}`, `2026-10-0${5 + i}`, '09:00', r)));

  it('is a report request with a schema that only knows the review keys', () => {
    const req = buildInsightRequest(c, { period: { from: '2026-10-05', to: '2026-10-11' }, tradeCount: 5 });
    expect(req.purpose).toBe('report');
    expect(req.temperature).toBe(0.2);
    const schema = req.responseSchema as any;
    expect(schema.required).toEqual(Object.keys(schema.properties));
    expect(schema.properties.fromNotes).toBeUndefined();
    expect(INSIGHT_SYSTEM).toMatch(/Never recommend buying, selling or holding/);
    expect(INSIGHT_SYSTEM).toMatch(/never about the person/);
  });

  it('sends computed facts only: no notes or lessons unless switched on', () => {
    const text = buildInsightRequest(c, { period: { from: '2026-10-05', to: '2026-10-11' }, tradeCount: 5 }).contents[0].parts[0];
    expect('text' in text && text.text).toContain('"netPnl":{"label":"Net P&L","value":"0.00"}');
    expect('text' in text && text.text).not.toMatch(/notes|lessons|images|email/i);
    const withNotes = reviewOf([1, -2, 1, -1, 1].map((r, i) => rTrade(`t${i}`, `2026-10-0${5 + i}`, '09:00', r, { notes: `note ${i}` })), { useNotes: true });
    const p = reviewPayload(withNotes, { period: { from: '2026-10-05', to: '2026-10-11' }, tradeCount: 5 });
    expect(p.notes).toHaveLength(5);
    const schema = buildInsightRequest(withNotes, { period: { from: '2026-10-05', to: '2026-10-11' }, tradeCount: 5 }).responseSchema as any;
    expect(schema.properties.fromNotes.items.properties.quotes.items.properties.tradeId.enum).toEqual(withNotes.notes!.map((n) => n.id));
  });
});

describe('notes themes', () => {
  const t = [
    rTrade('a', '2026-10-05', '09:00', -1, { notes: 'Entered late, chased the move.' }),
    rTrade('b', '2026-10-06', '09:00', -1, { lessons: ['Chased the move again'] }),
    rTrade('c', '2026-10-07', '09:00', 2, { notes: 'Waited for the retest.' }),
    rTrade('d', '2026-10-08', '09:00', 1),
    rTrade('e', '2026-10-09', '09:00', -1),
  ];
  const c = reviewOf(t, { useNotes: true });
  const allowed = allowedNumbers(reviewPayload(c, { period: { from: '2026-10-05', to: '2026-10-11' }, tradeCount: 5 }));

  it('keeps only quotes found in that trade\'s own note or lessons', () => {
    const v = validateInsight({
      fromNotes: [
        { theme: 'Losing trades mention chasing the move; winners mention waiting.', side: 'both', quotes: [{ tradeId: 'a', quote: 'chased the move' }, { tradeId: 'b', quote: '"Chased the move again"' }, { tradeId: 'c', quote: 'chased the move' }, { tradeId: 'zzz', quote: 'x' }] },
        { theme: 'Invented', side: 'losing', quotes: [{ tradeId: 'e', quote: 'I was tired' }] },
        { theme: 'Counts made up: 4 trades', side: 'losing', quotes: [{ tradeId: 'a', quote: 'Entered late' }] },
      ],
    }, c, allowed);
    expect(v.review.fromNotes).toEqual([{ theme: 'Losing trades mention chasing the move; winners mention waiting.', side: 'both', quotes: [{ tradeId: 'a', quote: 'chased the move' }, { tradeId: 'b', quote: 'Chased the move again' }] }]);
  });

  it('switched off: the block stays absent whatever the model sends', () => {
    const off = reviewOf(t);
    expect(validateInsight({ fromNotes: [{ theme: 'x', side: 'both', quotes: [{ tradeId: 'a', quote: 'Entered late' }] }] }, off, allowed).review.fromNotes).toBeUndefined();
  });
});

/** The text a trader reads, in the order of research report §5.2 (what the app renders from the JSON). */
export function readable(summary: string, r: Review, header: string): string {
  const lines = [header, '', 'Verdict', `  ${r.verdict.text}`];
  if (r.theOne) {
    lines.push('', 'The one thing', `  ${r.theOne.title}: ${r.theOne.text}`, `  [View ${r.theOne.trades} trades]   [Make this my focus: "${r.theOne.ruleText}"]`);
    for (const f of r.more) lines.push(`  Also: ${f.title}: ${f.text}`);
  }
  if (r.lastFocus) lines.push('', "Last week's focus", `  ${r.lastFocus.text}`);
  if (r.keepDoing) lines.push('', 'Keep doing', `  ${r.keepDoing.text}`);
  if (r.different.length) lines.push('', 'Different from your normal', ...r.different.map((d) => `  ${d.text}`));
  if (r.fromNotes) lines.push('', 'From your notes', ...r.fromNotes.map((n) => `  ${n.theme} ${n.quotes.map((q) => `"${q.quote}" (${q.tradeId})`).join(', ')}`));
  if (r.watch.length) lines.push('', 'Patterns to watch (not enough trades to call)', ...r.watch.map((w) => `  ${w.text}`));
  return [`${summary}`, '', ...lines].join('\n');
}

describe('G5: the INR account of report §5.2, model mocked', () => {
  const c = reviewOf(qaTrades('INR'), { currency: 'INR', period: { from: '2026-08-10', to: '2026-11-04' }, timeZone: 'Asia/Kolkata' });
  const prompt = { period: { from: '2026-08-10', to: '2026-11-04' }, tradeCount: 23 };
  const allowed = allowedNumbers(reviewPayload(c, prompt));
  const model = {
    summary: 'A losing period of 23 trades, net −₹56,787.78, and nearly half of the loss came from trades that went past their own stop.',
    verdict: 'A losing period, and nearly half of the loss came from trades that went past your own stop.',
    findings: [{ key: 'detector:beyondStop', text: '11 of 17 losing trades went past the stop, which cost ₹26,382.89 beyond plan. Had every loss ended at the stop you set, the period would have lost ₹30,404.89 instead of ₹56,787.78.' }],
    watch: [
      { key: 'segment:weekday:fri', text: 'Fridays: 7 trades, all lost, −₹51,006.18; 4 of them were NIFTY, so "Fridays" and "NIFTY" are largely the same trades. Too few trades to call.' },
      { key: 'detector:losersHeldLonger', text: 'Losers held longer than winners: 7 trades that lost ₹41,250.00 in all.' },
      { key: 'mistake:moved stop loss', text: 'You are a natural at moving stops: 4 trades, +₹1,406.25.' },
    ],
  };
  const v = validateInsight(model, c, allowed);

  it('keeps the model wording that uses code numbers only, and replaces the rest with the code sentence', () => {
    expect(v.review.verdict.text).toBe(model.verdict);
    expect(v.review.theOne!.text).toBe(model.findings[0].text);
    expect(v.review.watch.find((w) => w.key === 'segment:weekday:fri')!.text).toBe(model.watch[0].text);
    // ₹41,250.00 is not a figure of the data, and praise of the person is not allowed: both fall back.
    expect(onlyKnownNumbers('₹41,250.00', allowed)).toBe(false);
    expect(v.review.watch.find((w) => w.key === 'detector:losersHeldLonger')!.text).toBe(c.review.watch.find((w) => w.key === 'detector:losersHeldLonger')!.text);
    expect(v.review.watch.find((w) => w.key === 'mistake:moved stop loss')!.text).toContain('It has paid so far; that is not evidence that it works.');
  });

  it('every number a trader reads comes from code', () => {
    const texts = [v.summary, v.review.verdict.text, v.review.theOne!.text, ...v.review.more.map((f) => f.text), ...v.review.watch.map((w) => w.text), ...v.review.different.map((d) => d.text)];
    for (const t of texts) expect(onlyKnownNumbers(t, allowed)).toBe(true);
    expect(v.review.theOne).toMatchObject({ key: 'detector:beyondStop', trades: 11, cost: 26382.89, costR: 6.0997, rule: { kind: 'exitAtStop' } });
    expect(v.sections.map((s) => s.kind)).toEqual(['leak', 'action', 'pattern', 'pattern', 'pattern', 'pattern']);
    if (process.env.PRINT_G5) console.log(JSON.stringify({ summary: v.summary, review: v.review }, null, 2), '\n\n', readable(v.summary, v.review, 'Zerodha F&O · 23 trades (early: numbers will move a lot) · net −₹56,787.78'));
  });
});
