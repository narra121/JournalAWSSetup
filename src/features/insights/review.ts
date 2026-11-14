import { createHash } from 'node:crypto';
import { beyondStopAmount, computeDetectors, OVERTRADING_MULTIPLE, REENTRY_MINUTES, SIZE_UP_MULTIPLE } from '../analysis/detectors';
import { bootstrapMean, mean, sampleLabel, verdict as evidenceVerdict } from '../analysis/evidence';
import { BEYOND_STOP_R, groupByDay, median, tradeFacts, type TradeFacts } from '../analysis/facts';
import { groupBy, netOf, r4, round2, roundRange, rsOf } from '../analysis/segments';
import { DIMENSIONS, type DetectorId, type Dimension, type SampleLabel, type Verdict } from '../analysis/types';
import { brokenBy, focusCheck, focusRuleText } from '../focus/rules';
import type { Focus, FocusRule } from '../focus/types';
import { dayOf } from '../../shared/timezone';
import type { TradeRow } from '../trades-repo';
import { money, ordinalWord, pct, plural, rText } from './format';
import { addDays, historyOf, isoWeekStart, resolvedSince, type HistoryRow } from './history';
import { brokenRuleGroups, computeChatMetrics, mistakeGroups, usableTrades, type MetricMap } from './metrics';
import type { DifferentItem, DifferentMeasure, FindingKey, FindingSource, KeepDoing, LastFocus, Review, ReviewFinding, ReviewVerdict, WatchItem } from './types';

export const BASELINE_DAYS = 90;
export const NORMAL_WEEKS = 12;
const MIN_NORMAL_WEEKS = 6;
const MAX_FINDINGS = 3;
const MAX_WATCH = 4;
const MIN_WATCH_TRADES = 3;
/** Overlaps noted per watch item; more are merged silently. */
const MAX_WATCH_OVERLAPS = 2;
/** A broad segment (most of the period's trades) is the trader's normal, not a pattern. */
const MAX_WATCH_SEGMENT_SHARE = 0.6;
/** Slices of the data in the watch list; the other places go to behaviours. */
const MAX_WATCH_SEGMENTS = 2;
/** A candidate with at least this share of its trades already in a finding is the same cause: merged into it. */
const OVERLAP_SHARE = 0.5;
/** A segment holding this share of the period's trades says nothing about the rest (e.g. "options" for an options trader). */
const MAX_SEGMENT_SHARE = 0.9;
export const MAX_IDS = 100;
const MAX_NOTES_TRADES = 40;
const NOTE_CHARS = 300;
const LESSON_CHARS = 120;

/** Behaviours that are process breaks by definition: their cost is accounting, so they count from the first trade. */
const PROCESS_DETECTORS: DetectorId[] = ['beyondStop', 'noStop', 'reentryAfterLoss', 'sizeUpAfterLoss', 'overtradingDay', 'afterDailyLimit'];
/** Behaviours that are a cost only if the evidence rule says so (verdict 'leak'); otherwise patterns to watch. */
const PATTERN_DETECTORS: DetectorId[] = ['afterLoss', 'tradeNumber', 'expiryDay'];
/** Covered by detectors (tradeNumber, expiryDay) or not a behaviour of its own. */
const SEGMENT_DIMENSIONS: Dimension[] = DIMENSIONS.filter((d) => d !== 'tradeNumber' && d !== 'expiryDay');
/** Known only once the trade has closed, so no rule at entry can skip them: watched, never a costed finding. */
const WATCH_DIMENSIONS: Dimension[] = ['holding'];

export interface ReviewInput {
  period: { from: string; to: string };
  timeZone: string;
  currency: string | null;
  /** the period's trades */
  trades: TradeRow[];
  /** trades of the BASELINE_DAYS days before the period */
  baseline: TradeRow[];
  ruleTexts: Map<string, string>;
  focus: Focus | null;
  muted: Set<FindingKey>;
  /** rows of the weeks before the period's ISO week, this scope only */
  history: HistoryRow[];
  useNotes: boolean;
}

export interface NoteInput {
  id: string;
  result: 'win' | 'loss' | 'break-even';
  net: string;
  r: string | null;
  note: string | null;
  lessons: string[];
}

export interface Computed {
  metrics: MetricMap;
  baseMetricIds: string[];
  review: Review;
  /** ids of the period's trades */
  tradeIds: Set<string>;
  /** notes sent to the model; null when the trader has not switched notes on */
  notes: NoteInput[] | null;
  /** rows to store for the period's ISO week */
  historyRows: Omit<HistoryRow, 'weekStart'>[];
  weekStart: string;
  hash: string;
}

type Kind = 'process' | 'pattern' | 'watch';
interface Cand {
  key: FindingKey;
  source: FindingSource;
  title: string;
  kind: Kind;
  /** members over baseline + period, and in the period only */
  win: TradeFacts[];
  per: TradeFacts[];
  verdict: Verdict;
  label: SampleLabel;
  beyond: boolean;
  rule: FocusRule | null;
  ruleText: string;
  /** the trader's own label (a broken rule or a mistake tag): a net gain is shown as "paid so far" */
  selfTagged?: boolean;
}

const DIM_TITLE: Record<Dimension, (name: string) => string> = {
  symbol: (n) => n,
  setup: (n) => `Setup "${n}"`,
  session: (n) => `${n} session`,
  direction: (n) => `${n} trades`,
  assetClass: (n) => `Asset class "${n}"`,
  weekday: (n) => `${n}s`,
  hour: (n) => `Trades opened ${n}`,
  marketCondition: (n) => `Market condition "${n}"`,
  newsEvent: (n) => `News event "${n}"`,
  tag: (n) => `Tag "${n}"`,
  plannedRR: (n) => n,
  holding: (n) => n,
  tradeNumber: (n) => n,
  optionType: (n) => n,
  expiryDay: (n) => n,
};

const capIds = (fs: TradeFacts[]) => fs.slice(0, MAX_IDS).map((f) => f.t.id);
const costOf = (beyond: boolean, fs: TradeFacts[]) => round2(beyond ? fs.reduce((s, f) => s + beyondStopAmount(f), 0) : Math.max(0, -netOf(fs)));
function costROf(beyond: boolean, fs: TradeFacts[]): number | null {
  const rs = rsOf(fs);
  if (!rs.length) return null;
  return r4(beyond ? rs.filter((r) => r < BEYOND_STOP_R).reduce((s, r) => s + (-r - 1), 0) : Math.max(0, -rs.reduce((s, r) => s + r, 0)));
}

function detectorRule(id: DetectorId, wf: TradeFacts[]): FocusRule | null {
  switch (id) {
    case 'beyondStop': return { kind: 'exitAtStop' };
    case 'noStop': return { kind: 'setStop' };
    case 'reentryAfterLoss': return { kind: 'pauseAfterLoss', minutes: REENTRY_MINUTES };
    case 'afterLoss': return { kind: 'stopAfterLosses', n: 1 };
    case 'sizeUpAfterLoss': return { kind: 'maxRiskMultiple', multiple: SIZE_UP_MULTIPLE };
    case 'overtradingDay': {
      const usual = median([...groupByDay(wf).values()].map((d) => d.length)) ?? 1;
      return { kind: 'maxTradesPerDay', n: Math.max(3, Math.floor(OVERTRADING_MULTIPLE * usual)) };
    }
    case 'tradeNumber': return { kind: 'maxTradesPerDay', n: 1 };
    case 'expiryDay': return { kind: 'skipSegment', dimension: 'expiryDay', key: 'expiry-day' };
    default: return null;
  }
}

const dayBand = (n: number) => (n <= 3 ? String(n) : n <= 5 ? '4-5' : '6+');

function candidates(wf: TradeFacts[], pf: TradeFacts[], input: ReviewInput): Cand[] {
  const inPeriod = new Set(pf);
  const periodOf = (fs: TradeFacts[]) => fs.filter((f) => inPeriod.has(f));
  const byId = new Map(wf.map((f) => [f.t.id, f]));
  const factsOf = (ts: TradeRow[]) => ts.map((t) => byId.get(t.id)!).filter(Boolean);
  const out: Cand[] = [];

  for (const d of computeDetectors(wf, { currency: input.currency, ruleTexts: input.ruleTexts })) {
    if (d.id === 'brokenRule') continue;
    const win = d.tradeIds.map((id) => byId.get(id)!);
    // The rest (losersHeldLonger, targetNotReached, fees) have no cost without price data, or compare by construction: watched only.
    const kind: Kind = PROCESS_DETECTORS.includes(d.id) ? 'process' : PATTERN_DETECTORS.includes(d.id) ? 'pattern' : 'watch';
    const rule = detectorRule(d.id, wf);
    out.push({ key: `detector:${d.id}`, source: 'detector', title: d.title, kind, win, per: periodOf(win), verdict: d.verdict, label: d.label, beyond: d.id === 'beyondStop', rule, ruleText: rule ? focusRuleText(rule) : '' });
  }

  const tagged = (source: 'rule' | 'mistake', groups: { key: string; name: string; trades: TradeRow[] }[]) => {
    for (const g of groups) {
      const win = factsOf(g.trades);
      const inside = new Set(win);
      const v = evidenceVerdict({ a: rsOf(win), b: rsOf(wf.filter((f) => !inside.has(f))), candidates: groups.length });
      out.push({
        key: `${source}:${g.key}`, source, kind: 'process', win, per: periodOf(win), verdict: v, label: sampleLabel(win.length), beyond: false, rule: null,
        title: source === 'rule' ? `Broke "${g.name}"` : `Tagged "${g.name}"`,
        ruleText: source === 'rule' ? `If a trade would break my rule "${g.name}", I skip it.` : `If I notice "${g.name}" before an entry, I skip the trade.`,
        selfTagged: true,
      });
    }
  };
  const windowTrades = wf.map((f) => f.t);
  tagged('rule', brokenRuleGroups(windowTrades, input.ruleTexts));
  tagged('mistake', mistakeGroups(windowTrades));

  // Judged together like the Analytics segment tables: every group of every dimension plus the trades-per-day bands.
  const groups = DIMENSIONS.map((dim) => [dim, groupBy(wf, dim)] as const);
  const nCandidates = Math.max(1, groups.reduce((s, [, gs]) => s + gs.length, 0) + new Set(wf.map((f) => dayBand(f.dayTrades))).size);
  for (const [dim, gs] of groups) {
    if (!SEGMENT_DIMENSIONS.includes(dim)) continue;
    for (const g of gs) {
      const per = periodOf(g.members);
      if (!per.length || per.length >= MAX_SEGMENT_SHARE * pf.length) continue;
      const inside = new Set(g.members);
      const rule: FocusRule = { kind: 'skipSegment', dimension: dim, key: g.key };
      out.push({
        key: `segment:${dim}:${g.key}`, source: 'segment', title: DIM_TITLE[dim](g.name), kind: WATCH_DIMENSIONS.includes(dim) ? 'watch' : 'pattern', win: g.members, per,
        verdict: evidenceVerdict({ a: rsOf(g.members), b: rsOf(wf.filter((f) => !inside.has(f))), candidates: nCandidates }),
        label: sampleLabel(g.members.length), beyond: false, rule, ruleText: focusRuleText(rule, g.name),
      });
    }
  }
  return out;
}

interface Attributed {
  c: Cand;
  own: TradeFacts[];
  overlaps: { key: FindingKey; title: string; shared: number }[];
}

/**
 * Picks the costliest candidate, gives it the trades no earlier pick holds, and repeats, so each trade's money is
 * counted once. A candidate whose trades are mostly held already is the same cause and is merged as an overlap.
 */
function attribute(cands: Cand[], limit: number): { picked: Attributed[]; merged: Set<FindingKey> } {
  const claimed = new Map<TradeFacts, Attributed>();
  const picked: Attributed[] = [];
  const merged = new Set<FindingKey>();
  let pool = cands.filter((c) => costOf(c.beyond, c.per) > 0);
  while (pool.length && picked.length < limit) {
    let best: { c: Cand; own: TradeFacts[]; cost: number } | null = null;
    for (const c of pool) {
      const own = c.per.filter((f) => !claimed.has(f));
      const cost = costOf(c.beyond, own);
      if (cost > 0 && (!best || cost > best.cost || (cost === best.cost && c.key < best.c.key))) best = { c, own, cost };
    }
    if (!best) break;
    const a: Attributed = { c: best.c, own: best.own, overlaps: [] };
    picked.push(a);
    for (const f of best.own) claimed.set(f, a);
    pool = pool.filter((c) => {
      if (c === best!.c) return false;
      const held = c.per.filter((f) => claimed.has(f));
      if (held.length < OVERLAP_SHARE * c.per.length) return true;
      const counts = new Map<Attributed, number>();
      for (const f of held) counts.set(claimed.get(f)!, (counts.get(claimed.get(f)!) ?? 0) + 1);
      const [into, shared] = [...counts].sort((x, y) => y[1] - x[1])[0];
      into.overlaps.push({ key: c.key, title: c.title, shared });
      merged.add(c.key);
      return false;
    });
  }
  return { picked, merged };
}

function replayOf(c: Cand, wf: TradeFacts[], pf: TradeFacts[]): ReviewFinding['replay'] {
  const actualNet = netOf(pf);
  if (c.rule?.kind === 'setStop') return null;
  if (c.rule?.kind === 'exitAtStop') return { actualNet, replayNet: round2(actualNet + pf.reduce((s, f) => s + beyondStopAmount(f), 0)), removed: 0 };
  const inPeriod = new Set(pf);
  const removed = c.rule ? [...brokenBy(wf, c.rule)].filter((f) => inPeriod.has(f)) : c.per;
  return { actualNet, replayNet: round2(actualNet - netOf(removed)), removed: removed.length };
}

function historyText(h: ReviewFinding['history'], count: number): string {
  if (h.weeksInRow >= 2) {
    const row = `${ordinalWord(h.weeksInRow).replace(/^./, (x) => x.toUpperCase())} week in a row`;
    if (h.status === 'down') return ` ${row}, down from ${h.lastWeekCount} trades last week to ${count}.`;
    if (h.status === 'up') return ` ${row}, up from ${h.lastWeekCount} trades last week to ${count}.`;
    return ` ${row}.`;
  }
  return '';
}

function evidenceText(c: Cand, wf: TradeFacts[]): string {
  if (c.kind !== 'pattern') return '';
  const inside = new Set(c.win);
  const a = mean(rsOf(c.win));
  const b = mean(rsOf(wf.filter((f) => !inside.has(f))));
  const rs = a != null && b != null ? `: ${rText(a)} a trade against ${rText(b)} for the rest` : '';
  return ` Over the last ${BASELINE_DAYS} days and this period it covers ${plural(c.win.length, 'trade')}${rs}, which passes the evidence rule.`;
}

function overlapText(o: { title: string; shared: number }[]): string {
  if (!o.length) return '';
  return ` These trades also cover ${o.map((x) => `${x.title} (${plural(x.shared, 'trade')})`).join(', ')}; their money is counted here once.`;
}

function findingOf(a: Attributed, input: ReviewInput, wf: TradeFacts[], pf: TradeFacts[], weekStart: string): ReviewFinding {
  const { c, own } = a;
  const cur = input.currency;
  const cost = costOf(c.beyond, own);
  const costR = costROf(c.beyond, own);
  const history = historyOf(c.key, c.per.length, input.history, weekStart);
  const replay = replayOf(c, wf, pf);
  const unit = periodUnit(input.period);
  const costPart = `${money(cost, cur)}${costR ? ` (${rText(costR, true)})` : ''}`;
  let lead: string;
  if (c.beyond) {
    const losers = pf.filter((f) => f.t.pnl < 0).length;
    lead = `${own.length} of ${plural(losers, 'losing trade')} went past the stop; the part beyond the stop cost ${costPart}.`;
  } else if (c.key === 'detector:noStop') {
    lead = `${plural(own.length, 'trade')} had no stop recorded and lost ${costPart} together.`;
  } else {
    lead = `${c.title} (${plural(own.length, 'trade')}): ${costPart} lost.`;
  }
  const replayPart = replay
    ? c.beyond
      ? ` Had every loss ended at the stop, the ${unit} would have ended at ${money(replay.replayNet, cur)} instead of ${money(replay.actualNet, cur)}.`
      : replay.removed
        ? ` With the rule, ${plural(replay.removed, 'trade')} would not have been taken and the ${unit} would have ended at ${money(replay.replayNet, cur)} instead of ${money(replay.actualNet, cur)}.`
        : ''
    : '';
  const text = `${lead}${replayPart}${overlapText(a.overlaps)}${historyText(history, c.per.length)}${evidenceText(c, wf)}`.trim();
  return {
    key: c.key, source: c.source, title: c.title,
    trades: own.length, tradeIds: capIds(own),
    cost, costR,
    net: netOf(own), avgR: r4(mean(rsOf(own))),
    evidenceTrades: c.win.length, label: c.label, verdict: c.verdict,
    basis: c.kind === 'process' ? 'accounting' : 'evidence',
    ruleText: c.ruleText, rule: c.rule, replay,
    overlaps: a.overlaps, history, text,
  };
}

const periodDays = (p: { from: string; to: string }) => Math.round((Date.parse(`${p.to}T00:00:00Z`) - Date.parse(`${p.from}T00:00:00Z`)) / 86_400_000) + 1;
const periodUnit = (p: { from: string; to: string }) => (periodDays(p) === 7 ? 'week' : 'period');

function watchList(cands: Cand[], exclude: Set<FindingKey>, periodTrades: number, cur: string | null): WatchItem[] {
  const pool = cands
    .filter((c) => !exclude.has(c.key) && c.verdict !== 'edge' && c.per.length >= MIN_WATCH_TRADES)
    .filter((c) => c.kind !== 'process' || (c.selfTagged && netOf(c.per) >= 0))
    .filter((c) => c.source !== 'segment' || c.per.length <= MAX_WATCH_SEGMENT_SHARE * periodTrades)
    .sort((a, b) => Math.abs(netOf(b.per)) - Math.abs(netOf(a.per)) || (a.key < b.key ? -1 : 1));
  const paid = pool.find((c) => c.selfTagged && netOf(c.per) > 0);
  const chosen: { c: Cand; item: WatchItem }[] = [];
  const slotsLeft = (c: Cand) => {
    const segments = chosen.filter((x) => x.c.source === 'segment').length;
    const reserve = paid && c !== paid && !chosen.some((x) => x.c === paid) ? 1 : 0;
    return chosen.length < MAX_WATCH - reserve && (c.source !== 'segment' || segments < MAX_WATCH_SEGMENTS);
  };
  const sets = new Map<Cand, Set<TradeFacts>>();
  for (const c of pool) {
    const host = chosen.map((x) => ({ x, shared: c.per.filter((f) => sets.get(x.c)!.has(f)).length })).sort((a, b) => b.shared - a.shared)[0];
    // A trader's own tag that paid stays its own item: "it paid, which is not evidence" is the point of showing it.
    if (host && host.shared >= OVERLAP_SHARE * c.per.length && c !== paid) {
      if (host.x.item.overlaps.length < MAX_WATCH_OVERLAPS) host.x.item.overlaps.push({ key: c.key, title: c.title, shared: host.shared });
      continue;
    }
    if (!slotsLeft(c)) continue;
    const wins = c.per.filter((f) => f.t.pnl > 0).length;
    const item: WatchItem = {
      key: c.key, source: c.source, title: c.title, trades: c.per.length, wins, net: netOf(c.per), avgR: r4(mean(rsOf(c.per))), tradeIds: capIds(c.per),
      evidenceTrades: c.win.length, label: c.label, paidSoFar: !!c.selfTagged && netOf(c.per) > 0, overlaps: [], text: '',
    };
    chosen.push({ c, item });
    sets.set(c, new Set(c.per));
  }
  return chosen.map(({ item }) => ({ ...item, text: watchText(item, cur) }));
}

function watchText(w: WatchItem, cur: string | null): string {
  const result = w.wins === 0 ? 'all lost' : w.wins === w.trades ? 'all won' : `${w.wins} won`;
  const r = w.avgR == null ? '' : `, ${rText(w.avgR)} per trade`;
  const overlaps = w.overlaps.length ? ` They also cover most of ${w.overlaps.map((o) => `${o.title} (${plural(o.shared, 'trade')})`).join(' and ')}, so these are largely the same trades.` : '';
  const paid = w.paidSoFar ? ' It has paid so far; that is not evidence that it works.' : '';
  const evidence = w.label === 'too-few'
    ? ` ${plural(w.evidenceTrades, 'trade')} over the last ${BASELINE_DAYS} days and this period are too few to call it.`
    : ` Over ${plural(w.evidenceTrades, 'trade')} in the last ${BASELINE_DAYS} days and this period it does not pass the evidence rule yet.`;
  return `${w.title}: ${plural(w.trades, 'trade')} (${result})${r}, ${money(w.net, cur)}.${overlaps}${paid}${evidence}`;
}

function keepDoingOf(cands: Cand[], muted: Set<FindingKey>): KeepDoing | undefined {
  const edges = cands.filter((c) => c.source === 'segment' && c.verdict === 'edge' && !muted.has(c.key));
  const best = edges.sort((a, b) => (b.per.length > 0 ? 1 : 0) - (a.per.length > 0 ? 1 : 0) || (mean(rsOf(b.win)) ?? 0) - (mean(rsOf(a.win)) ?? 0))[0];
  if (!best) return undefined;
  const rs = rsOf(best.win);
  const wins = best.win.filter((f) => f.t.pnl > 0).length;
  const avgR = r4(mean(rs));
  const kd: KeepDoing = {
    key: best.key, title: best.title, trades: best.win.length, periodTrades: best.per.length, winRate: r4(wins / best.win.length)!,
    avgR, avgRRange: roundRange(bootstrapMean(rs)), label: best.label, text: '',
  };
  kd.text = `${best.title}: ${plural(kd.trades, 'trade')} over the last ${BASELINE_DAYS} days and this period, ${pct(kd.winRate)} won${avgR == null ? '' : `, ${rText(avgR)} per trade`}, clearly better than the rest of your trades. ${plural(kd.periodTrades, 'trade')} this period.`;
  return kd;
}

interface Measures { tradesPerDay: number | null; riskPerTrade: number | null; avgR: number | null; winRate: number | null }
function measures(fs: TradeFacts[], minForRates: number): Measures {
  const days = new Set(fs.map((f) => f.day)).size;
  const rs = rsOf(fs);
  const risks = fs.map((f) => f.risk).filter((x): x is number => x != null && x > 0);
  return {
    tradesPerDay: days ? fs.length / days : null,
    riskPerTrade: median(risks),
    avgR: rs.length >= minForRates ? mean(rs) : null,
    winRate: fs.length >= minForRates ? fs.filter((f) => f.t.pnl > 0).length / fs.length : null,
  };
}

const MEASURE_NAME: Record<DifferentMeasure, string> = { tradesPerDay: 'Trades per trading day', riskPerTrade: 'Money at risk per trade (median)', avgR: 'Average R', winRate: 'Win rate' };
function showMeasure(m: DifferentMeasure, v: number, cur: string | null): string {
  if (m === 'tradesPerDay') return v.toFixed(1);
  if (m === 'riskPerTrade') return money(v, cur);
  if (m === 'avgR') return rText(v);
  return pct(v);
}

function differentFrom(baselineFacts: TradeFacts[], pf: TradeFacts[], from: string, cur: string | null): DifferentItem[] {
  const weeks: Measures[] = [];
  for (let k = 1; k <= NORMAL_WEEKS; k++) {
    const start = addDays(from, -7 * k);
    const end = addDays(start, 6);
    const fs = baselineFacts.filter((f) => f.day >= start && f.day <= end);
    if (fs.length) weeks.push(measures(fs, 3));
  }
  const now = measures(pf, 5);
  const out: DifferentItem[] = [];
  for (const m of ['tradesPerDay', 'riskPerTrade', 'avgR', 'winRate'] as DifferentMeasure[]) {
    const v = now[m];
    const vals = weeks.map((w) => w[m]).filter((x): x is number => x != null);
    if (v == null || vals.length < MIN_NORMAL_WEEKS) continue;
    const lo = Math.min(...vals), hi = Math.max(...vals);
    const rv = r4(v)!;
    if (rv <= r4(hi)! && rv >= r4(lo)!) continue;
    const direction = rv > r4(hi)! ? 'above' : 'below';
    const round = m === 'riskPerTrade' ? round2 : (x: number) => r4(x)!;
    const item: DifferentItem = { key: `different:${m}`, measure: m, value: round(v), normalLo: round(lo), normalHi: round(hi), weeks: vals.length, direction, text: '' };
    item.text = `${MEASURE_NAME[m]}: ${showMeasure(m, item.value, cur)}, ${direction === 'above' ? 'higher' : 'lower'} than in any of your last ${item.weeks} weeks with trades (${showMeasure(m, item.normalLo, cur)} to ${showMeasure(m, item.normalHi, cur)}).`;
    out.push(item);
  }
  return out;
}

function verdictOf(pf: TradeFacts[], processCands: Cand[], processCost: number, focus: Focus | null, period: { from: string; to: string }): ReviewVerdict {
  const n = pf.length;
  const net = netOf(pf);
  const rs = rsOf(pf);
  const netR = rs.length ? r4(rs.reduce((s, r) => s + r, 0)) : null;
  const useR = netR != null && rs.length * 2 >= n;
  const value = useR ? netR! : net;
  const result = Math.abs(value) < 0.005 ? 'flat' : value > 0 ? 'winning' : 'losing';
  const broken = new Set(processCands.flatMap((c) => c.per));
  const cleanShare = n ? (n - broken.size) / n : 1;
  const losersR = pf.filter((f) => f.t.pnl < 0 && f.r != null);
  const cap = focus?.rule.kind === 'maxTradesPerDay' ? focus.rule.n : null;
  const selfInflictedShare = result === 'losing' && net < 0 ? Math.min(1, processCost / -net) : null;
  const process = cleanShare >= 0.8 ? 'clean' : cleanShare >= 0.5 ? 'mixed' : 'poor';
  const u = periodUnit(period);
  const best = Math.max(0, ...pf.map((f) => f.t.pnl));
  let headline: string;
  if (result === 'losing') {
    if (process === 'clean') headline = `A losing ${u}, played well.`;
    else if ((selfInflictedShare ?? 0) >= 0.5) headline = `A losing ${u}, mostly self-inflicted.`;
    else if ((selfInflictedShare ?? 0) > 0) headline = `A losing ${u}, partly self-inflicted.`;
    else headline = `A losing ${u}; the process breaks did not add to the loss.`;
  } else if (result === 'winning') {
    if (n >= 3 && net > 0 && best >= net) headline = `A winning ${u}, but one trade made it.`;
    else if (process === 'clean') headline = `A winning ${u}, played well.`;
    else headline = `A winning ${u}, with process breaks.`;
  } else headline = `A flat ${u}.`;
  return {
    result, process, net, netR, tradesWithR: rs.length,
    cleanShare: r4(cleanShare)!,
    stopShare: r4(n ? pf.filter((f) => f.t.stopLoss != null && f.t.stopLoss > 0).length / n : 0)!,
    keptToStopShare: losersR.length ? r4(losersR.filter((f) => f.r! >= BEYOND_STOP_R).length / losersR.length) : null,
    insideCapShare: cap != null && n ? r4(pf.filter((f) => f.tradeNumber <= cap).length / n) : null,
    selfInflictedShare: selfInflictedShare == null ? null : r4(selfInflictedShare),
    headline, text: headline,
  };
}

function lastFocusOf(focus: Focus | null, wf: TradeFacts[], pf: TradeFacts[], input: ReviewInput): LastFocus | undefined {
  if (!focus || dayOf(focus.startedAt, input.timeZone) > input.period.to) return undefined;
  const since = Date.parse(focus.startedAt);
  const inPeriod = new Set(pf);
  const check = focusCheck(wf, focus.rule, (f) => inPeriod.has(f) && f.openMs >= since);
  const cost = check.cost ? `, which cost ${money(check.cost, input.currency)}` : '';
  const text = check.checked
    ? `"${focus.text}": kept on ${check.kept} of ${plural(check.checked, 'trade')}, broken on ${check.broken}${cost}.`
    : `"${focus.text}": no trade this ${periodUnit(input.period)} to check it on.`;
  return { ...check, brokenTradeIds: check.brokenTradeIds.slice(0, MAX_IDS), rule: focus.rule, ruleText: focus.text, startedAt: focus.startedAt, text };
}

const clip = (s: string, n: number) => s.replace(/\s+/g, ' ').trim().slice(0, n);

function notesOf(pf: TradeFacts[], cur: string | null): NoteInput[] {
  return pf
    .filter((f) => f.t.notes?.trim() || f.t.lessons.some((l) => l.trim()))
    .sort((a, b) => Math.abs(b.t.pnl) - Math.abs(a.t.pnl) || a.index - b.index)
    .slice(0, MAX_NOTES_TRADES)
    .map((f) => ({
      id: f.t.id,
      result: f.t.pnl > 0 ? 'win' : f.t.pnl < 0 ? 'loss' : 'break-even',
      net: money(f.t.pnl, cur),
      r: f.r == null ? null : rText(f.r),
      note: f.t.notes?.trim() ? clip(f.t.notes, NOTE_CHARS) : null,
      lessons: f.t.lessons.map((l) => clip(l, LESSON_CHARS)).filter(Boolean).slice(0, 3),
    }));
}

/** Everything the weekly review shows, computed from trades (research report §5.2). Pure: same input, same output. */
export function computeInsightInputs(input: ReviewInput): Computed {
  const periodTrades = usableTrades(input.trades);
  const periodIds = new Set(periodTrades.map((t) => t.id));
  const windowTrades = [...usableTrades(input.baseline).filter((t) => !periodIds.has(t.id)), ...periodTrades];
  const wf = tradeFacts(windowTrades, input.timeZone);
  const pf = wf.filter((f) => periodIds.has(f.t.id));
  const baselineFacts = wf.filter((f) => !periodIds.has(f.t.id));
  const { metrics, baseMetricIds } = computeChatMetrics(periodTrades);
  const weekStart = isoWeekStart(input.period.to);

  const all = candidates(wf, pf, input);
  const visible = all.filter((c) => !input.muted.has(c.key));
  const costed = visible.filter((c) => c.kind === 'process' || (c.kind === 'pattern' && c.verdict === 'leak'));
  const { picked, merged } = attribute(costed, MAX_FINDINGS);
  const findings = picked.map((a) => findingOf(a, input, wf, pf, weekStart));

  const processCands = all.filter((c) => c.kind === 'process' && c.per.length);
  const processCost = attribute(processCands, Infinity).picked.reduce((s, a) => s + costOf(a.c.beyond, a.own), 0);
  const verdict = verdictOf(pf, processCands, processCost, input.focus, input.period);

  const shown = new Set(findings.map((f) => f.key));
  const watch = watchList(visible, new Set([...shown, ...merged]), pf.length, input.currency);
  const keepDoing = keepDoingOf(all, input.muted);
  const different = differentFrom(baselineFacts, pf, input.period.from, input.currency).filter((d) => !input.muted.has(d.key));
  const lastFocus = lastFocusOf(input.focus, wf, pf, input);
  const counts = new Map(all.map((c) => [c.key, c.per.length]));
  const resolved = resolvedSince(input.history, weekStart, (k) => counts.get(k) ?? 0).filter((r) => !input.muted.has(r.key));
  const muted = [...new Set(all.filter((c) => input.muted.has(c.key) && c.per.length).map((c) => c.key))].sort();

  const review: Review = {
    version: 1,
    currency: input.currency,
    timeZone: input.timeZone,
    baseline: { from: addDays(input.period.from, -BASELINE_DAYS), to: addDays(input.period.from, -1), trades: baselineFacts.length },
    verdict,
    theOne: findings[0] ?? null,
    more: findings.slice(1),
    ...(lastFocus ? { lastFocus } : {}),
    ...(keepDoing ? { keepDoing } : {}),
    different,
    ...(input.useNotes ? { fromNotes: [] } : {}),
    watch,
    resolved,
    muted,
  };

  const shownKeys = new Set([...shown, ...watch.map((w) => w.key)]);
  const historyRows = all
    .filter((c) => c.per.length && (c.source !== 'segment' || shownKeys.has(c.key)))
    .map((c) => ({ key: c.key, title: c.title, count: c.per.length, net: netOf(c.per), avgR: r4(mean(rsOf(c.per))), shown: shown.has(c.key) }));

  const notes = input.useNotes ? notesOf(pf, input.currency) : null;
  const hash = createHash('sha256').update(JSON.stringify({ v: 2, b: baseMetricIds.map((k) => metrics[k].value), review, notes })).digest('hex');
  return { metrics, baseMetricIds, review, tradeIds: periodIds, notes, historyRows, weekStart, hash };
}
