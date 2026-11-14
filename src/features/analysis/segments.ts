import { bootstrapMean, mean, MIN_RANGE_TRADES, sampleLabel, verdict, wilson } from './evidence';
import type { TradeFacts } from './facts';
import { DIMENSIONS, type Dimension, type Segment, type Verdict } from './types';

export const round2 = (v: number) => Math.round((v + Number.EPSILON) * 100) / 100;
export const r4 = (v: number | null) => (v == null ? null : Math.round(v * 10_000) / 10_000);
export const netOf = (fs: TradeFacts[]) => round2(fs.reduce((s, f) => s + f.t.pnl, 0));
export const rsOf = (fs: TradeFacts[]) => fs.map((f) => f.r).filter((r): r is number => r != null);
export const idsOf = (fs: TradeFacts[]) => fs.map((f) => f.t.id);

export interface DimValue {
  key: string;
  name: string;
}

const text = (s: string | null | undefined): DimValue | null => {
  const name = (s ?? '').replace(/\s+/g, ' ').trim().slice(0, 80);
  return name ? { key: name.toLowerCase(), name } : null;
};
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const pad2 = (n: number) => String(n).padStart(2, '0');
const ORDINAL = ['1st', '2nd', '3rd'];

const RR_BANDS: [number, string, string][] = [[1, 'under-1', 'Planned under 1R'], [2, '1-2', 'Planned 1R to 2R'], [3, '2-3', 'Planned 2R to 3R'], [Infinity, '3-plus', 'Planned 3R or more']];
const HOLD_BANDS: [number, string, string][] = [[5, 'under-5m', 'Held under 5 min'], [30, '5-30m', 'Held 5 to 30 min'], [120, '30m-2h', 'Held 30 min to 2 h'], [1440, '2h-1d', 'Held 2 h to 1 day'], [Infinity, 'over-1d', 'Held over 1 day']];
const band = (v: number, bands: [number, string, string][]): DimValue => {
  const [, key, name] = bands.find(([below]) => v < below)!;
  return { key, name };
};

const isOption = (f: TradeFacts) => f.t.optionType != null || f.t.assetClass?.toLowerCase() === 'options';

/** The segments of `dim` a trade belongs to: none, one, or several for the list fields (tags, news events). */
export function dimensionValues(f: TradeFacts, dim: Dimension): DimValue[] {
  const one = (v: DimValue | null) => (v ? [v] : []);
  const t = f.t;
  switch (dim) {
    case 'symbol': return one(text(t.symbol));
    case 'setup': return one(text(t.setupType));
    case 'session': return one(text(t.tradingSession));
    case 'direction': return [t.side === 'SELL' ? { key: 'short', name: 'Short' } : { key: 'long', name: 'Long' }];
    case 'assetClass': return one(text(t.assetClass));
    case 'weekday': return [{ key: WEEKDAYS[f.weekday].slice(0, 3).toLowerCase(), name: WEEKDAYS[f.weekday] }];
    case 'hour': return f.hour == null ? [] : [{ key: pad2(f.hour), name: `${pad2(f.hour)}:00-${pad2((f.hour + 1) % 24)}:00` }];
    case 'marketCondition': return one(text(t.marketCondition));
    case 'newsEvent': return uniq(t.newsEvents.map(text));
    case 'tag': return uniq(t.tags.map(text));
    case 'plannedRR': return f.plannedRR == null ? [] : [band(f.plannedRR, RR_BANDS)];
    case 'holding': return f.holdingMin == null ? [] : [band(f.holdingMin, HOLD_BANDS)];
    case 'tradeNumber': return [f.tradeNumber >= 4 ? { key: '4+', name: '4th or later trade of the day' } : { key: String(f.tradeNumber), name: `${ORDINAL[f.tradeNumber - 1]} trade of the day` }];
    case 'optionType': return t.optionType ? [{ key: t.optionType, name: t.optionType === 'call' ? 'Calls' : 'Puts' }] : [];
    case 'expiryDay': return isOption(f) && t.expiry ? [t.expiry.slice(0, 10) === f.day ? { key: 'expiry-day', name: 'On expiry day' } : { key: 'other-day', name: 'Before expiry day' }] : [];
  }
}

function uniq(vs: (DimValue | null)[]): DimValue[] {
  const m = new Map<string, DimValue>();
  for (const v of vs) if (v && !m.has(v.key)) m.set(v.key, v);
  return [...m.values()];
}

/** Dimensions shown in their natural order (charts); the rest are ranked by evidence. */
const ORDERED: Partial<Record<Dimension, string[]>> = {
  weekday: ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'],
  plannedRR: RR_BANDS.map((b) => b[1]),
  holding: HOLD_BANDS.map((b) => b[1]),
  tradeNumber: ['1', '2', '3', '4+'],
  expiryDay: ['expiry-day', 'other-day'],
};

export const matchesValue = (v: DimValue, wanted: string) => {
  const w = wanted.trim().toLowerCase();
  return v.key === w || v.name.toLowerCase() === w;
};

export interface Group {
  key: string;
  name: string;
  members: TradeFacts[];
}

/** Trades grouped by the values of `dim`, members in open order. */
export function groupBy(facts: TradeFacts[], dim: Dimension): Group[] {
  const m = new Map<string, Group>();
  for (const f of facts) {
    for (const v of dimensionValues(f, dim)) (m.get(v.key) ?? m.set(v.key, { ...v, members: [] }).get(v.key)!).members.push(f);
  }
  return [...m.values()];
}

/**
 * One segment: its figures, and its evidence against every other trade of `all` (R values, in time order).
 * `candidates` is the number of segments judged together (Bonferroni).
 */
export function segmentOf(key: string, name: string, members: TradeFacts[], all: TradeFacts[], candidates: number, seed?: number): Segment {
  const wins = members.filter((f) => f.t.pnl > 0).length;
  const n = members.length;
  const rs = rsOf(members);
  const inside = new Set(members);
  const rest = rsOf(all.filter((f) => !inside.has(f)));
  const won = members.reduce((s, f) => s + Math.max(0, f.t.pnl), 0);
  const lost = members.reduce((s, f) => s - Math.min(0, f.t.pnl), 0);
  return {
    key, name, trades: n, wins,
    winRate: n ? wins / n : 0,
    winRateRange: n >= MIN_RANGE_TRADES ? wilson(wins, n) : null,
    net: netOf(members),
    profitFactor: lost > 0 ? r4(won / lost) : null,
    avgR: r4(mean(rs)),
    avgRRange: roundRange(bootstrapMean(rs, { seed })),
    verdict: verdict({ a: rs, b: rest, candidates }),
    label: sampleLabel(n),
    tradeIds: idsOf(members),
  };
}

export const roundRange = (r: { lo: number; hi: number } | null) => (r ? { lo: r4(r.lo)!, hi: r4(r.hi)! } : null);

const VERDICT_RANK: Record<Verdict, number> = { edge: 0, leak: 1, watch: 2 };
export function sortSegments(dim: Dimension, segs: Segment[]): Segment[] {
  const order = ORDERED[dim];
  if (order) return segs.sort((a, b) => order.indexOf(a.key) - order.indexOf(b.key));
  if (dim === 'hour') return segs.sort((a, b) => (a.key < b.key ? -1 : 1));
  return segs.sort((a, b) => VERDICT_RANK[a.verdict] - VERDICT_RANK[b.verdict] || b.trades - a.trades || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

const DAY_BANDS: [number, string, string][] = [[2, '1', '1 trade a day'], [3, '2', '2 trades a day'], [4, '3', '3 trades a day'], [6, '4-5', '4 to 5 trades a day'], [Infinity, '6+', '6 or more trades a day']];

/**
 * Every one-way segment of every dimension, and the trades-per-day bands. All of them are judged together, so
 * `candidates` is their total.
 */
export function segmentTables(facts: TradeFacts[]): { segments: Record<Dimension, Segment[]>; tradesPerDay: Segment[] } {
  const groups = DIMENSIONS.map((dim) => [dim, groupBy(facts, dim)] as const);
  const dayBands = new Map<string, Group>();
  for (const f of facts) {
    const v = band(f.dayTrades, DAY_BANDS);
    (dayBands.get(v.key) ?? dayBands.set(v.key, { ...v, members: [] }).get(v.key)!).members.push(f);
  }
  const candidates = Math.max(1, groups.reduce((s, [, gs]) => s + gs.length, 0) + dayBands.size);
  const segments = Object.fromEntries(groups.map(([dim, gs]) => [dim, sortSegments(dim, gs.map((g) => segmentOf(g.key, g.name, g.members, facts, candidates)))])) as Record<Dimension, Segment[]>;
  const order = DAY_BANDS.map((b) => b[1]);
  const tradesPerDay = [...dayBands.values()]
    .map((g) => ({ ...segmentOf(g.key, g.name, g.members, facts, candidates), days: new Set(g.members.map((f) => f.day)).size }))
    .sort((a, b) => order.indexOf(a.key) - order.indexOf(b.key));
  return { segments, tradesPerDay };
}
