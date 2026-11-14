import { fmt, type Metric } from './metrics';
import { money } from './format';
import type { Computed } from './review';
import type { NoteTheme, Review } from './types';

export type SectionKind = 'strength' | 'leak' | 'pattern' | 'action';
/** The section list every insight carries; old insights have only this, new ones also have `review`. */
export interface InsightSection {
  kind: SectionKind;
  title: string;
  body: string;
  metric?: Metric;
  tradeIds?: string[];
}

export const MAX_SECTIONS = 8;
const SECTION_TRADES = 5;
const MAX_THEMES = 3;
const MAX_QUOTES = 3;

const clamp = (s: unknown, n: number) => (typeof s === 'string' ? s.replace(/\s+/g, ' ').trim().slice(0, n) : '');

/** Numbers as written in a text ("₹26,382.89" → 26382.89, "8.4R" → 8.4); signs are ignored. */
export function numbersIn(text: string): { value: number; decimals: number }[] {
  return [...text.matchAll(/\d[\d,]*(?:\.\d+)?/g)].map((m) => {
    const raw = m[0].replace(/,/g, '');
    return { value: Number(raw), decimals: raw.includes('.') ? raw.split('.')[1].length : 0 };
  });
}

const SKIP_KEYS = new Set(['key', 'id', 'tradeId', 'tradeIds', 'notes']);
/** Every number in the payload sent to the model (ids, keys and the trader's notes left out): the only numbers a text may show. */
export function allowedNumbers(payload: unknown): number[] {
  const out = new Set<number>();
  const walk = (v: unknown, key?: string) => {
    if (key && SKIP_KEYS.has(key)) return;
    if (typeof v === 'number' && Number.isFinite(v)) out.add(Math.abs(v));
    else if (typeof v === 'string') for (const n of numbersIn(v)) out.add(n.value);
    else if (Array.isArray(v)) v.forEach((x) => walk(x));
    else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) walk(x, k);
  };
  walk(payload);
  return [...out];
}

/** True when every number in `text` is an allowed number, a share of one written as a percentage, or one of them rounded. */
export function onlyKnownNumbers(text: string, allowed: number[]): boolean {
  return numbersIn(text).every(({ value, decimals }) => {
    const f = 10 ** decimals;
    return allowed.some((a) => [a, a * 100].some((v) => Math.abs(Math.round(v * f) / f - value) < 1e-9));
  });
}

const PERSON = /\b(great|good|nice|excellent|fantastic) (job|work)\b|\bwell done\b|\bproud\b|\bimpressive\b|\bcongratulations\b|\byou(?: are|'re) (?:a |an |so |very |too )?(?:great|good|excellent|disciplined|undisciplined|bad|poor|terrible|impulsive|reckless|lazy|careless|emotional|greedy|natural|talented|smart)\b/i;
const ADVICE = /\b(buy|sell)(s|ing)?\b|\bhold (it|on|the position)\b|\bprice target\b|\btarget price\b|\b(will|going to) (rise|fall|go up|go down|rally|crash|recover)\b/i;

/** The model's text when it is usable, else the code's: no unknown number, nothing about the person, no market advice. */
export function wording(model: unknown, fallback: string, max: number, allowed: number[]): string {
  const t = clamp(model, max);
  if (!t || !onlyKnownNumbers(t, allowed) || PERSON.test(t)) return fallback;
  if (ADVICE.test(t) && !ADVICE.test(fallback)) return fallback;
  return t;
}

const norm = (s: string) => s.replace(/[\s"“”'‘’]+/g, ' ').trim().toLowerCase();

function themesOf(raw: unknown, c: Computed, allowed: number[]): NoteTheme[] {
  const notes = new Map((c.notes ?? []).map((n) => [n.id, norm([n.note ?? '', ...n.lessons].join(' \u0000 '))]));
  const out: NoteTheme[] = [];
  for (const t of Array.isArray(raw) ? raw : []) {
    if (out.length === MAX_THEMES) break;
    const o = (t && typeof t === 'object' ? t : {}) as Record<string, unknown>;
    const theme = wording(o.theme, '', 160, allowed);
    const side = o.side === 'winning' || o.side === 'losing' || o.side === 'both' ? o.side : null;
    if (!theme || !side) continue;
    const quotes: NoteTheme['quotes'] = [];
    for (const q of Array.isArray(o.quotes) ? o.quotes : []) {
      const qo = (q && typeof q === 'object' ? q : {}) as Record<string, unknown>;
      const tradeId = typeof qo.tradeId === 'string' ? qo.tradeId : '';
      const quote = clamp(qo.quote, 200).replace(/^["“']+|["”']+$/g, '');
      const source = notes.get(tradeId);
      if (!source || norm(quote).length < 3 || !source.includes(norm(quote)) || quotes.some((x) => x.tradeId === tradeId)) continue;
      quotes.push({ tradeId, quote });
      if (quotes.length === MAX_QUOTES) break;
    }
    if (quotes.length) out.push({ theme, side, quotes });
  }
  return out;
}

const byKey = (raw: unknown): Map<string, unknown> =>
  new Map((Array.isArray(raw) ? raw : []).filter((x) => x && typeof x === 'object').map((x) => [String((x as Record<string, unknown>).key), (x as Record<string, unknown>).text]));

/** Sections for screens and the chat that read only `sections`, made from the review. */
export function sectionsOf(r: Review): InsightSection[] {
  const cur = r.currency;
  const out: InsightSection[] = [];
  for (const f of [r.theOne, ...r.more]) {
    if (!f) continue;
    out.push({ kind: 'leak', title: f.title.slice(0, 80), body: f.text, metric: { label: 'Cost', value: f.cost, unit: 'currency', display: fmt(f.cost, 'currency') }, ...(f.tradeIds.length ? { tradeIds: f.tradeIds.slice(0, SECTION_TRADES) } : {}) });
  }
  if (r.theOne) {
    const rp = r.theOne.replay;
    const replay = rp && rp.replayNet !== rp.actualNet ? ` Replayed with this rule, the period ends at ${money(rp.replayNet, cur)} instead of ${money(rp.actualNet, cur)}.` : '';
    out.push({ kind: 'action', title: 'Rule to try', body: `${r.theOne.ruleText}${replay}` });
  }
  if (r.keepDoing) out.push({ kind: 'strength', title: r.keepDoing.title.slice(0, 80), body: r.keepDoing.text });
  for (const w of r.watch) out.push({ kind: 'pattern', title: w.title.slice(0, 80), body: w.text, ...(w.tradeIds.length ? { tradeIds: w.tradeIds.slice(0, SECTION_TRADES) } : {}) });
  return out.slice(0, MAX_SECTIONS);
}

/**
 * Turns the model's JSON into the stored report. Every number and trade id comes from `c`; the model supplies wording
 * only, and any text that fails `wording` is replaced by the code's sentence. Notes themes keep only quotes found in
 * the trader's notes of the trades sent.
 */
export function validateInsight(raw: unknown, c: Computed, allowed: number[]): { summary: string; sections: InsightSection[]; review: Review } {
  const obj = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const review: Review = structuredClone(c.review);
  const w = (model: unknown, fallback: string, max: number) => wording(model, fallback, max, allowed);

  review.verdict.text = w(obj.verdict, review.verdict.headline, 240);
  const findings = byKey(obj.findings);
  for (const f of [review.theOne, ...review.more]) if (f) f.text = w(findings.get(f.key), f.text, 500);
  const watch = byKey(obj.watch);
  for (const x of review.watch) x.text = w(watch.get(x.key), x.text, 400);
  const different = byKey(obj.different);
  for (const x of review.different) x.text = w(different.get(x.key), x.text, 300);
  if (review.keepDoing) review.keepDoing.text = w(obj.keepDoing, review.keepDoing.text, 400);
  if (review.fromNotes) review.fromNotes = themesOf(obj.fromNotes, c, allowed);

  const m = c.metrics;
  const summary = w(obj.summary, `${review.verdict.headline} ${m.trades.display} trades, net ${money(m.netPnl.value ?? 0, review.currency)}.`, 400);
  return { summary, sections: sectionsOf(review), review };
}
