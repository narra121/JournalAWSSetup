import type { ToolCall, ToolDecl } from '../ai/gemini';
import { parseAnalysisQuery, runQuery } from '../analysis/query';
import { DIMENSIONS, type AnalysisQuery, type PeriodBounds, type QueryResult, type SampleLabel } from '../analysis/types';
import type { TradeRow } from '../trades-repo';

/** Tool rounds per user message (CONTRACT I7); the call after the last round has no tools and must answer. */
export const MAX_TOOL_ROUNDS = 3;
/** Calls run per round; further calls in the same round get an error result. */
export const MAX_CALLS_PER_ROUND = 3;
/** Trade ids kept per table in the done frame and the stored message (DynamoDB items stop at 400 KB). */
export const MAX_TABLE_TRADE_IDS = 200;

const SEGMENT_KEYS =
  'Segment keys: weekday mon..sun; hour two digits in the user\'s time zone, e.g. "09"; direction long or short; ' +
  'tradeNumber 1, 2, 3 or 4+; plannedRR under-1, 1-2, 2-3 or 3-plus; holding under-5m, 5-30m, 30m-2h, 2h-1d or over-1d; ' +
  'optionType call or put; expiryDay expiry-day or other-day; symbol, setup, session, assetClass, marketCondition, newsEvent ' +
  'and tag take the name as the user wrote it (any case).';

const DIMENSION_HELP =
  'Dimensions: symbol; setup (strategy); session; direction (long/short); assetClass; weekday; hour (hour the trade opened); ' +
  'marketCondition; newsEvent; tag; plannedRR (planned reward-to-risk band); holding (holding-time band); ' +
  'tradeNumber (1st, 2nd, 3rd, 4th or later trade of the day); optionType (calls/puts); expiryDay (options on expiry day or before).';

const filtersSchema = {
  type: 'object',
  description: `Keep only the trades in these segments (all must match). ${SEGMENT_KEYS}`,
  properties: Object.fromEntries(DIMENSIONS.map((d) => [d, { type: 'string' }])),
};
const dimensionSchema = { type: 'string', enum: [...DIMENSIONS] };
const periodSchema = (which: string) => ({
  type: 'object',
  description: `${which} date range, days as YYYY-MM-DD inside the chat period.`,
  properties: { from: { type: 'string', description: 'first day, YYYY-MM-DD' }, to: { type: 'string', description: 'last day, YYYY-MM-DD' } },
  required: ['from', 'to'],
});

/** One tool per AnalysisQuery kind; the tool name is the kind. */
export const CHAT_TOOLS: ToolDecl[] = [
  {
    name: 'stats',
    description:
      "Totals per group of the user's trades in the chat period: trades, wins, win rate, net P&L, average R with its 95% range, " +
      'verdict and sample label per group. Use it for questions like "which setup made me the most money", "which weekday loses most", ' +
      `"how do my BANKNIFTY trades do". groupBy [] gives one row for all trades. ${DIMENSION_HELP}`,
    parameters: {
      type: 'object',
      properties: {
        groupBy: { type: 'array', items: dimensionSchema, maxItems: 2, description: 'Zero, one or two dimensions to group by.' },
        filters: filtersSchema,
      },
      required: ['groupBy'],
    },
  },
  {
    name: 'sequence',
    description:
      'How the trades taken right after a losing (or winning) trade did, against all other trades: trades, wins, win rate, net P&L, ' +
      'average R, verdict and sample label for both groups. Use it for "how do I do after a loss", "do I revenge trade".',
    parameters: {
      type: 'object',
      properties: {
        after: { type: 'string', enum: ['loss', 'win'], description: 'Result of the previous closed trade.' },
        sameDay: { type: 'boolean', description: 'true = only when that previous trade was on the same day.' },
        withinMinutes: { type: 'integer', minimum: 1, maximum: 1440, description: 'Optional: only trades opened within this many minutes of that close.' },
      },
      required: ['after', 'sameDay'],
    },
  },
  {
    name: 'whatIf',
    description:
      'Replays the chat period without the trades a rule would have blocked: actual against replayed net P&L, average R and number of trades. ' +
      'It only removes trades that happened, so it predicts nothing. Rule kinds: stopAfterLosses (n losses in a day, then stop), ' +
      'maxTradesPerDay (n), noTradesAfter (time HH:MM, user\'s time zone), skipSegment (dimension and key), ' +
      'maxRiskMultiple (skip trades risking more than multiple × the median risk).',
    parameters: {
      type: 'object',
      properties: {
        rule: {
          type: 'object',
          properties: {
            kind: { type: 'string', enum: ['stopAfterLosses', 'maxTradesPerDay', 'noTradesAfter', 'skipSegment', 'maxRiskMultiple'] },
            n: { type: 'integer', minimum: 1, maximum: 100, description: 'stopAfterLosses and maxTradesPerDay' },
            time: { type: 'string', description: 'noTradesAfter, HH:MM 24-hour, e.g. 14:30' },
            dimension: { ...dimensionSchema, description: 'skipSegment' },
            key: { type: 'string', description: `skipSegment segment key. ${SEGMENT_KEYS}` },
            multiple: { type: 'number', minimum: 1, maximum: 100, description: 'maxRiskMultiple, e.g. 2' },
          },
          required: ['kind'],
        },
      },
      required: ['rule'],
    },
  },
  {
    name: 'trades',
    description:
      'Lists single trades to cite as [#id]: date, symbol, direction, setup, net P&L and R. sort pnl, r or date; order desc ' +
      '(best, largest R or newest first, the default) or asc (worst or oldest first); limit 1 to 20; filters as in stats.',
    parameters: {
      type: 'object',
      properties: {
        sort: { type: 'string', enum: ['pnl', 'r', 'date'] },
        order: { type: 'string', enum: ['desc', 'asc'] },
        limit: { type: 'integer', minimum: 1, maximum: 20 },
        filters: filtersSchema,
      },
      required: ['sort', 'limit'],
    },
  },
  {
    name: 'compare',
    description:
      'Compares two date ranges inside the chat period: trades, win rate, net P&L, net P&L per trade, average R, payoff and a verdict.',
    parameters: { type: 'object', properties: { a: periodSchema('First'), b: periodSchema('Second') }, required: ['a', 'b'] },
  },
];

const KINDS = new Set(CHAT_TOOLS.map((t) => t.name));

const LABEL_MEANING: Record<SampleLabel, string> = {
  'too-few': 'fewer than 20 trades: too few to rely on',
  early: '20 to 29 trades: early, the numbers can still move a lot',
  provisional: '30 to 99 trades: provisional',
  established: '100 or more trades: established',
};

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const num = (v: unknown) => (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v)) ? Number(v) : v);

/** Forgives the slips small models make (a single dimension as a string, numbers as text, an hour as 9) before strict validation. */
function normalise(name: string, args: Record<string, unknown>): Record<string, unknown> {
  const o: Record<string, unknown> = { ...args, kind: name };
  if (name === 'stats') o.groupBy = o.groupBy == null ? [] : typeof o.groupBy === 'string' ? [o.groupBy] : o.groupBy;
  if (isObj(o.filters)) {
    const f: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(o.filters)) {
      if (v == null || v === '') continue;
      const s = typeof v === 'number' ? String(v) : v;
      f[k] = k === 'hour' && typeof s === 'string' && /^\d$/.test(s.trim()) ? `0${s.trim()}` : s;
    }
    o.filters = Object.keys(f).length ? f : undefined;
  }
  for (const k of ['limit', 'withinMinutes']) if (o[k] != null) o[k] = num(o[k]);
  if (isObj(o.rule)) o.rule = { ...o.rule, ...(o.rule.n != null ? { n: num(o.rule.n) } : {}), ...(o.rule.multiple != null ? { multiple: num(o.rule.multiple) } : {}) };
  return o;
}

/** The query a tool call stands for, or the message the model gets back when the arguments are invalid. */
export function toolQuery(call: ToolCall, period: PeriodBounds): AnalysisQuery | string {
  if (!KINDS.has(call.name)) return `Unknown tool ${call.name}. Use one of ${[...KINDS].join(', ')}.`;
  const q = parseAnalysisQuery(normalise(call.name, isObj(call.args) ? call.args : {}));
  if (typeof q === 'string') return q;
  if (q.kind === 'compare' && [q.a, q.b].some((p) => p.from < period.from || p.to > period.to)) {
    return `a and b must lie inside the chat period, ${period.from} to ${period.to}.`;
  }
  return q;
}

export interface ToolContext {
  trades: TradeRow[];
  timeZone: string;
  currency: string | null;
  period: PeriodBounds;
  /** the period held more trades than were loaded */
  truncated: boolean;
}

const pct = (v: string | number | null) => (typeof v === 'number' ? Math.round(v * 1000) / 10 : v);

/** What the model reads: rows as objects, rates as percents, the label spelled out; no trade id lists except per trade row. */
export function modelView(q: AnalysisQuery, r: QueryResult, tableNo: number, ctx: ToolContext): Record<string, unknown> {
  const rows = r.rows.map((row, i) => {
    const o: Record<string, unknown> = {};
    r.columns.forEach((col, j) => {
      if (col === 'winRate') o.winRatePercent = pct(row[j]);
      else o[col] = row[j];
    });
    if (q.kind === 'compare' && o.measure === 'Win rate') {
      o.measure = 'Win rate (percent)';
      for (const k of Object.keys(o)) if (k !== 'measure') o[k] = pct(o[k] as number | null);
    }
    if (q.kind === 'trades') o.id = r.tradeIds[i];
    return o;
  });
  // Small models misread "most money" off a list ordered by trade count; the extremes are picked here, in code.
  let extremes: Record<string, unknown> = {};
  if (q.kind === 'stats' && q.groupBy.length && r.rows.length > 1) {
    const net = r.columns.indexOf('net');
    const named = r.rows.map((row) => ({ group: row.slice(0, q.groupBy.length).join(' / '), net: row[net] as number, trades: row[q.groupBy.length] as number }));
    const sorted = [...named].sort((a, b) => b.net - a.net);
    extremes = { highestNet: sorted[0], lowestNet: sorted[sorted.length - 1] };
  }
  return {
    table: tableNo,
    currency: ctx.currency ?? 'unknown',
    sample: `${r.label} (${LABEL_MEANING[r.label]})`,
    ...(r.note ? { note: r.note } : {}),
    ...(ctx.truncated ? { partial: `Only the oldest ${ctx.trades.length} trades of the period were loaded.` } : {}),
    ...extremes,
    rows,
    ...(q.kind === 'stats' ? { units: 'net in the account currency; avgR in R; avgRLow/avgRHigh = 95% range of avgR (null below 20 trades); verdict edge/leak only when the evidence rule is met, else watch' } : {}),
  };
}

/** The table as the app gets it: trade ids capped (see MAX_TABLE_TRADE_IDS). */
export function appTable(r: QueryResult): QueryResult {
  if (r.tradeIds.length <= MAX_TABLE_TRADE_IDS) return r;
  const extra = `Trade links cover the first ${MAX_TABLE_TRADE_IDS} of ${r.tradeIds.length} trades.`;
  return { ...r, tradeIds: r.tradeIds.slice(0, MAX_TABLE_TRADE_IDS), note: r.note ? `${r.note} ${extra}` : extra };
}

/**
 * Runs one round of calls. Identical queries share one table; invalid arguments, unknown tools and calls beyond
 * MAX_CALLS_PER_ROUND come back to the model as `{error}` so it can correct itself.
 */
export function runToolRound(calls: ToolCall[], ctx: ToolContext, tables: { key: string; table: QueryResult }[]): { call: ToolCall; result: Record<string, unknown> }[] {
  return calls.map((call, i) => {
    if (i >= MAX_CALLS_PER_ROUND) return { call, result: { error: `At most ${MAX_CALLS_PER_ROUND} calls per turn; ask again for this one if you still need it.` } };
    const q = toolQuery(call, ctx.period);
    if (typeof q === 'string') return { call, result: { error: `Invalid arguments: ${q}` } };
    const key = JSON.stringify(q);
    let at = tables.findIndex((t) => t.key === key);
    let result: QueryResult;
    if (at >= 0) result = tables[at].table;
    else {
      try {
        result = runQuery(ctx.trades, q, { timeZone: ctx.timeZone });
      } catch {
        return { call, result: { error: 'This calculation failed. Try a different one or answer without it.' } };
      }
      at = tables.push({ key, table: result }) - 1;
    }
    return { call, result: modelView(q, result, at + 1, ctx) };
  });
}
