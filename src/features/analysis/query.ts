import { isCalendarDay } from '../../shared/timezone';
import type { TradeRow } from '../trades-repo';
import { bootstrapMean, mean, sampleLabel, verdict } from './evidence';
import { tradeFacts, type TradeFacts } from './facts';
import { dimensionValues, idsOf, matchesValue, netOf, r4, round2, rsOf, type DimValue } from './segments';
import { DIMENSIONS, type AnalysisQuery, type Dimension, type PeriodBounds, type QueryFilters, type QueryResult } from './types';
import { parseWhatIfRule, replay } from './whatif';

export const MAX_QUERY_ROWS = 50;
export const MAX_TRADE_ROWS = 20;

const matches = (f: TradeFacts, filters?: QueryFilters) =>
  !filters || Object.entries(filters).every(([dim, want]) => want == null || dimensionValues(f, dim as Dimension).some((v) => matchesValue(v, want)));

const rowFigures = (members: TradeFacts[], rest: TradeFacts[], candidates: number) => {
  const rs = rsOf(members);
  const wins = members.filter((f) => f.t.pnl > 0).length;
  const range = bootstrapMean(rs);
  return [
    members.length, wins, members.length ? r4(wins / members.length) : 0, netOf(members), r4(mean(rs)),
    range ? r4(range.lo) : null, range ? r4(range.hi) : null,
    verdict({ a: rs, b: rsOf(rest), candidates }), sampleLabel(members.length),
  ];
};
const FIGURE_COLUMNS = ['trades', 'wins', 'winRate', 'net', 'avgR', 'avgRLow', 'avgRHigh', 'verdict', 'label'];

/**
 * Answers one chat or API question from the trades (same time zone rules as buildAnalysis). Two-way groupings exist only
 * here: they are for exploring, judged with every cell as a candidate.
 */
export function runQuery(trades: TradeRow[], query: AnalysisQuery, opts: { timeZone: string }): QueryResult {
  const all = tradeFacts(trades, opts.timeZone);
  switch (query.kind) {
    case 'stats': {
      const facts = all.filter((f) => matches(f, query.filters));
      const cells = new Map<string, { values: DimValue[]; members: TradeFacts[] }>();
      for (const f of facts) {
        let combos: DimValue[][] = [[]];
        for (const dim of query.groupBy) combos = combos.flatMap((c) => dimensionValues(f, dim).map((v) => [...c, v]));
        for (const c of combos) {
          const k = c.map((v) => v.key).join('\u0000');
          (cells.get(k) ?? cells.set(k, { values: c, members: [] }).get(k)!).members.push(f);
        }
      }
      const list = [...cells.values()].sort((a, b) => b.members.length - a.members.length || (a.values.map((v) => v.key).join() < b.values.map((v) => v.key).join() ? -1 : 1));
      const shown = list.slice(0, MAX_QUERY_ROWS);
      const notes: string[] = [];
      if (query.groupBy.length === 2) notes.push('Two-way cells are for exploring only; a cell is judged only with 30 or more trades in it and outside it.');
      if (list.length > shown.length) notes.push(`Showing the ${MAX_QUERY_ROWS} largest of ${list.length} groups.`);
      if (!facts.length) notes.push('No trade matches these filters.');
      return {
        columns: [...(query.groupBy.length ? query.groupBy : ['group']), ...FIGURE_COLUMNS],
        rows: shown.map((c) => {
          const inside = new Set(c.members);
          return [...(query.groupBy.length ? c.values.map((v) => v.name) : ['All trades']), ...rowFigures(c.members, facts.filter((f) => !inside.has(f)), Math.max(1, list.length))];
        }),
        label: sampleLabel(facts.length),
        ...(notes.length ? { note: notes.join(' ') } : {}),
        tradeIds: idsOf(facts),
      };
    }
    case 'sequence': {
      const hit = (f: TradeFacts) =>
        !!f.prev && (query.after === 'loss' ? f.prev.pnl < 0 : f.prev.pnl > 0) && (!query.sameDay || f.prev.sameDay) &&
        (query.withinMinutes == null || (f.prev.minutesSinceClose != null && f.prev.minutesSinceClose <= query.withinMinutes));
      const members = all.filter(hit);
      const rest = all.filter((f) => !hit(f));
      const what = `After a ${query.after}${query.sameDay ? ' the same day' : ''}${query.withinMinutes != null ? ` within ${query.withinMinutes} min` : ''}`;
      return {
        columns: ['group', ...FIGURE_COLUMNS],
        rows: [[what, ...rowFigures(members, rest, 1)], ['All other trades', ...rowFigures(rest, members, 1)]],
        label: sampleLabel(members.length),
        tradeIds: idsOf(members),
      };
    }
    case 'whatIf': {
      const r = replay(all, query.rule);
      return {
        columns: ['measure', 'actual', 'replay'],
        rows: [['Net P&L', r.actualNet, r.replayNet], ['Average R', r.actualAvgR, r.replayAvgR], ['Trades', all.length, all.length - r.removed]],
        label: sampleLabel(all.length),
        note: 'The replay only removes trades that happened, so it predicts nothing.',
        tradeIds: r.removedTradeIds,
      };
    }
    case 'trades': {
      const facts = all.filter((f) => matches(f, query.filters));
      const dir = query.order === 'asc' ? 1 : -1;
      const key = (f: TradeFacts) => (query.sort === 'pnl' ? f.t.pnl : query.sort === 'r' ? f.r : f.openMs);
      const sorted = [...facts].sort((a, b) => {
        const ka = key(a), kb = key(b);
        if (ka == null || kb == null) return ka == null ? (kb == null ? a.index - b.index : 1) : -1;
        return (ka - kb) * dir || a.index - b.index;
      });
      const top = sorted.slice(0, Math.min(query.limit, MAX_TRADE_ROWS));
      return {
        columns: ['date', 'symbol', 'direction', 'setup', 'net', 'r'],
        rows: top.map((f) => [f.day, f.t.symbol, f.t.side === 'SELL' ? 'Short' : 'Long', f.t.setupType, round2(f.t.pnl), r4(f.r)]),
        label: sampleLabel(facts.length),
        ...(facts.length ? {} : { note: 'No trade matches these filters.' }),
        tradeIds: idsOf(top),
      };
    }
    case 'compare': {
      const inside = (p: PeriodBounds) => all.filter((f) => f.day >= p.from && f.day <= p.to);
      const a = inside(query.a);
      const b = inside(query.b);
      const summary = (fs: TradeFacts[]) => {
        const wins = fs.filter((f) => f.t.pnl > 0);
        const losses = fs.filter((f) => f.t.pnl < 0);
        const avgWin = mean(wins.map((f) => f.t.pnl));
        const avgLoss = mean(losses.map((f) => -f.t.pnl));
        return {
          trades: fs.length,
          winRate: fs.length ? r4(wins.length / fs.length) : null,
          net: netOf(fs),
          perTrade: fs.length ? round2(netOf(fs) / fs.length) : null,
          avgR: r4(mean(rsOf(fs))),
          payoff: avgWin != null && avgLoss ? r4(avgWin / avgLoss) : null,
        };
      };
      const sa = summary(a), sb = summary(b);
      return {
        columns: ['measure', `${query.a.from} to ${query.a.to}`, `${query.b.from} to ${query.b.to}`],
        rows: [
          ['Trades', sa.trades, sb.trades], ['Win rate', sa.winRate, sb.winRate], ['Net P&L', sa.net, sb.net],
          ['Net P&L per trade', sa.perTrade, sb.perTrade], ['Average R', sa.avgR, sb.avgR], ['Payoff', sa.payoff, sb.payoff],
          ['Verdict (first against second)', verdict({ a: rsOf(a), b: rsOf(b), candidates: 1 }), null],
        ],
        label: sampleLabel(Math.min(a.length, b.length)),
        tradeIds: [...new Set([...idsOf(a), ...idsOf(b)])],
      };
    }
  }
}

function parseFilters(x: unknown): QueryFilters | string | undefined {
  if (x == null) return undefined;
  if (typeof x !== 'object' || Array.isArray(x)) return 'filters must be an object of dimension → key.';
  const out: QueryFilters = {};
  for (const [k, v] of Object.entries(x)) {
    if (!DIMENSIONS.includes(k as Dimension)) return `unknown filter ${k}; use one of ${DIMENSIONS.join(', ')}.`;
    if (typeof v !== 'string' || !v.trim() || v.length > 100) return `filter ${k} must be a segment key.`;
    out[k as Dimension] = v;
  }
  return out;
}

const parsePeriod = (x: unknown): PeriodBounds | null => {
  const p = x as Record<string, unknown> | null;
  return p && typeof p.from === 'string' && typeof p.to === 'string' && isCalendarDay(p.from) && isCalendarDay(p.to) && p.from <= p.to ? { from: p.from, to: p.to } : null;
};

/** A query from untrusted JSON (API body, model tool call); a message when it is not one. */
export function parseAnalysisQuery(x: unknown): AnalysisQuery | string {
  const o = x as Record<string, unknown> | null;
  if (!o || typeof o !== 'object' || Array.isArray(o)) return 'query must be an object.';
  switch (o.kind) {
    case 'stats': {
      const g = o.groupBy;
      if (!Array.isArray(g) || g.length > 2 || g.some((d) => !DIMENSIONS.includes(d)) || new Set(g).size !== g.length) return `groupBy must list up to 2 different dimensions of ${DIMENSIONS.join(', ')}.`;
      const filters = parseFilters(o.filters);
      if (typeof filters === 'string') return filters;
      return { kind: 'stats', groupBy: g as Dimension[], ...(filters ? { filters } : {}) };
    }
    case 'sequence': {
      if (o.after !== 'loss' && o.after !== 'win') return 'after must be loss or win.';
      if (typeof o.sameDay !== 'boolean') return 'sameDay must be true or false.';
      if (o.withinMinutes != null && !(typeof o.withinMinutes === 'number' && Number.isFinite(o.withinMinutes) && o.withinMinutes > 0 && o.withinMinutes <= 1440)) return 'withinMinutes must be from 1 to 1440.';
      return { kind: 'sequence', after: o.after, sameDay: o.sameDay, ...(o.withinMinutes != null ? { withinMinutes: o.withinMinutes as number } : {}) };
    }
    case 'whatIf': {
      const rule = parseWhatIfRule(o.rule);
      return typeof rule === 'string' ? rule : { kind: 'whatIf', rule };
    }
    case 'trades': {
      if (o.sort !== 'pnl' && o.sort !== 'r' && o.sort !== 'date') return 'sort must be pnl, r or date.';
      if (o.order != null && o.order !== 'asc' && o.order !== 'desc') return 'order must be asc or desc.';
      if (!(typeof o.limit === 'number' && Number.isInteger(o.limit) && o.limit >= 1 && o.limit <= MAX_TRADE_ROWS)) return `limit must be a whole number from 1 to ${MAX_TRADE_ROWS}.`;
      const filters = parseFilters(o.filters);
      if (typeof filters === 'string') return filters;
      return { kind: 'trades', sort: o.sort, limit: o.limit, ...(o.order ? { order: o.order as 'asc' | 'desc' } : {}), ...(filters ? { filters } : {}) };
    }
    case 'compare': {
      const a = parsePeriod(o.a), b = parsePeriod(o.b);
      return a && b ? { kind: 'compare', a, b } : 'a and b must each be {from, to} days (YYYY-MM-DD), from on or before to.';
    }
    default:
      return 'kind must be stats, sequence, whatIf, trades or compare.';
  }
}
