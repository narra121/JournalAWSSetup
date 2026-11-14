import { realisedR } from '../analysis/facts';
import { round2 } from '../pnl';
import type { TradeRow } from '../trades-repo';

export type MetricUnit = 'currency' | 'percent' | 'count' | 'ratio' | 'streak';
export interface Metric {
  label: string;
  value: number | null;
  unit: MetricUnit;
  display: string;
}
export type MetricMap = Record<string, Metric>;

export const MIN_TRADES = 5;

export const fmt = (v: number | null, unit: MetricUnit): string => {
  if (v == null) return 'n/a';
  if (unit === 'percent') return `${round2(v)}%`;
  if (unit === 'count' || unit === 'streak') return String(Math.round(v));
  if (unit === 'ratio') return String(round2(v));
  return round2(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
};
export const metric = (label: string, value: number | null, unit: MetricUnit): Metric => ({ label, value, unit, display: fmt(value, unit) });

const closeKey = (t: TradeRow) => t.closeDate || t.openDate;

interface Group {
  key: string;
  trades: TradeRow[];
}

const net = (ts: TradeRow[]) => round2(ts.reduce((s, t) => s + t.pnl, 0));
const winRate = (ts: TradeRow[]) => (ts.length ? (ts.filter((t) => t.pnl > 0).length / ts.length) * 100 : 0);

function groupMany(trades: TradeRow[], keysOf: (t: TradeRow) => (string | null)[]): Group[] {
  const m = new Map<string, TradeRow[]>();
  for (const t of trades) {
    for (const k of new Set(keysOf(t))) if (k) (m.get(k) ?? m.set(k, []).get(k)!).push(t);
  }
  return [...m].map(([key, ts]) => ({ key, trades: ts }));
}

function maxStreak(sorted: TradeRow[], win: boolean) {
  let best = 0, cur = 0;
  for (const t of sorted) {
    cur = (win ? t.pnl > 0 : t.pnl < 0) ? cur + 1 : 0;
    best = Math.max(best, cur);
  }
  return best;
}

function maxDrawdown(sorted: TradeRow[]): number {
  let cum = 0, peak = 0, dd = 0;
  for (const t of sorted) {
    cum += t.pnl;
    peak = Math.max(peak, cum);
    dd = Math.max(dd, peak - cum);
  }
  return round2(dd);
}

export const safeText = (s: string) => s.replace(/\s+/g, ' ').slice(0, 80);

export const usableTrades = (all: TradeRow[]) => all.filter((t) => Number.isFinite(t.pnl) && t.openDate && Number.isFinite(Date.parse(t.openDate)));

/** The base metrics (everything the chat prompt needs). */
function baseMetrics(all: TradeRow[]) {
  const trades = usableTrades(all);
  const byClose = [...trades].sort((a, b) => (closeKey(a) < closeKey(b) ? -1 : closeKey(a) > closeKey(b) ? 1 : 0));

  const wins = trades.filter((t) => t.pnl > 0);
  const losses = trades.filter((t) => t.pnl < 0);
  const netPnl = net(trades);
  const fees = round2(trades.reduce((s, t) => s + t.fees, 0));
  const grossPnl = round2(netPnl + fees);
  const grossWin = wins.reduce((s, t) => s + t.pnl, 0);
  const grossLoss = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));
  const avgWin = wins.length ? grossWin / wins.length : null;
  const avgLoss = losses.length ? -grossLoss / losses.length : null;
  const rs = trades.map(realisedR).filter((r): r is number => r != null);

  const m: MetricMap = {
    trades: metric('Trades', trades.length, 'count'),
    wins: metric('Winning trades', wins.length, 'count'),
    losses: metric('Losing trades', losses.length, 'count'),
    winRate: metric('Win rate', winRate(trades), 'percent'),
    netPnl: metric('Net P&L', netPnl, 'currency'),
    grossPnl: metric('Gross P&L', grossPnl, 'currency'),
    fees: metric('Fees and charges', fees, 'currency'),
    feesPctOfGross: metric('Fees as % of gross profit', grossPnl > 0 ? (fees / grossPnl) * 100 : null, 'percent'),
    avgWin: metric('Average win', avgWin, 'currency'),
    avgLoss: metric('Average loss', avgLoss, 'currency'),
    payoff: metric('Payoff ratio (avg win / avg loss)', avgWin != null && avgLoss ? avgWin / Math.abs(avgLoss) : null, 'ratio'),
    profitFactor: metric('Profit factor', grossLoss > 0 ? grossWin / grossLoss : null, 'ratio'),
    expectancy: metric('Expectancy per trade', trades.length ? netPnl / trades.length : null, 'currency'),
    maxDrawdown: metric('Max drawdown', maxDrawdown(byClose), 'currency'),
    avgR: metric('Average R (trades with a stop)', rs.length ? rs.reduce((s, r) => s + r, 0) / rs.length : null, 'ratio'),
    largestWin: metric('Largest win', wins.length ? Math.max(...wins.map((t) => t.pnl)) : null, 'currency'),
    largestLoss: metric('Largest loss', losses.length ? Math.min(...losses.map((t) => t.pnl)) : null, 'currency'),
    maxWinStreak: metric('Longest winning streak', maxStreak(byClose, true), 'streak'),
    maxLossStreak: metric('Longest losing streak', maxStreak(byClose, false), 'streak'),
  };
  return { trades, m, baseMetricIds: Object.keys(m) };
}

/** Base metrics for the chat and the report payload. */
export function computeChatMetrics(all: TradeRow[]): { metrics: MetricMap; baseMetricIds: string[]; tradeIds: Set<string> } {
  const { trades, m, baseMetricIds } = baseMetrics(all);
  return { metrics: m, baseMetricIds, tradeIds: new Set(trades.map((t) => t.id)) };
}

/** Trades per broken rule, grouped by the rule's text (`key` = lower case, `name` = as written). */
export function brokenRuleGroups(trades: TradeRow[], ruleTexts: Map<string, string>): { key: string; name: string; trades: TradeRow[] }[] {
  // A rule is stored once per period (`week#<date>#<uuid>`), so one rule has many ids: group by its text.
  const ruleNames = new Map<string, string>();
  const ruleKeys = (t: TradeRow) => t.brokenRuleIds.map((id) => {
    const text = ruleTexts.get(id);
    if (!text) return null;
    const key = safeText(text).toLowerCase().trim();
    if (!ruleNames.has(key)) ruleNames.set(key, safeText(text));
    return key;
  });
  return groupMany(trades, ruleKeys).map((g) => ({ key: g.key, name: ruleNames.get(g.key)!.trim(), trades: g.trades }));
}

/** Trades per mistake tag (`key` = lower case, `name` = as written). */
export function mistakeGroups(trades: TradeRow[]): { key: string; name: string; trades: TradeRow[] }[] {
  const names = new Map<string, string>();
  const keys = (t: TradeRow) => t.mistakes.map((x) => {
    const name = x ? safeText(x).trim() : '';
    if (!name) return null;
    if (!names.has(name.toLowerCase())) names.set(name.toLowerCase(), name);
    return name.toLowerCase();
  });
  return groupMany(trades, keys).map((g) => ({ key: g.key, name: names.get(g.key)!, trades: g.trades }));
}
