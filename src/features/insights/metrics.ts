import { createHash } from 'node:crypto';
import { rMultiple, round2 } from '../pnl';
import type { TradeRow } from '../trades-repo';

export type MetricUnit = 'currency' | 'percent' | 'count' | 'ratio' | 'streak';
export interface Metric {
  label: string;
  value: number | null;
  unit: MetricUnit;
  display: string;
}
export type MetricMap = Record<string, Metric>;

export type FindingKind = 'strength' | 'leak' | 'pattern';
export interface Finding {
  id: string;
  kind: FindingKind;
  title: string;
  /** Plain facts computed here; the model rewrites them but cannot add numbers. */
  detail: string;
  metricRef: string;
  /** Absolute P&L effect (or a count for behaviour patterns); ranks candidates. */
  impact: number;
  tradeIds: string[];
}

export interface Computed {
  metrics: MetricMap;
  /** top-level metric ids always offered to the model (candidate metricRefs are added by the prompt builder) */
  baseMetricIds: string[];
  candidates: Finding[];
  tradeIds: Set<string>;
  hash: string;
}

export const MIN_TRADES = 5;
const MIN_GROUP = 5;
const REVENGE_MINUTES = 15;
const MAX_CANDIDATES = 12;
const IST_MS = 330 * 60_000;

const fmt = (v: number | null, unit: MetricUnit): string => {
  if (v == null) return 'n/a';
  if (unit === 'percent') return `${round2(v)}%`;
  if (unit === 'count' || unit === 'streak') return String(Math.round(v));
  if (unit === 'ratio') return String(round2(v));
  return round2(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
};
const metric = (label: string, value: number | null, unit: MetricUnit): Metric => ({ label, value, unit, display: fmt(value, unit) });

const ist = (iso: string) => new Date(Date.parse(iso) + IST_MS);
const istDay = (iso: string) => ist(iso).toISOString().slice(0, 10);
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const pad2 = (n: number) => String(n).padStart(2, '0');

const closeKey = (t: TradeRow) => t.closeDate || t.openDate;
const holdingMinutes = (t: TradeRow) => (t.closeDate ? (Date.parse(t.closeDate) - Date.parse(t.openDate)) / 60000 : null);
const holdingBucket = (m: number) => (m < 5 ? 'under 5 min' : m < 30 ? '5-30 min' : m < 120 ? '30 min-2 h' : m < 1440 ? '2 h-1 day' : 'over 1 day');

interface Group {
  key: string;
  trades: TradeRow[];
}

const net = (ts: TradeRow[]) => round2(ts.reduce((s, t) => s + t.pnl, 0));
const winRate = (ts: TradeRow[]) => (ts.length ? (ts.filter((t) => t.pnl > 0).length / ts.length) * 100 : 0);
const sample = (ts: TradeRow[], worst: boolean) =>
  [...ts].sort((a, b) => (worst ? a.pnl - b.pnl : b.pnl - a.pnl)).slice(0, 5).map((t) => t.id);

function groupMany(trades: TradeRow[], keysOf: (t: TradeRow) => (string | null)[]): Group[] {
  const m = new Map<string, TradeRow[]>();
  for (const t of trades) {
    for (const k of new Set(keysOf(t))) if (k) m.set(k, [...(m.get(k) ?? []), t]);
  }
  return [...m].map(([key, ts]) => ({ key, trades: ts }));
}
const group = (trades: TradeRow[], keyOf: (t: TradeRow) => string | null) => groupMany(trades, (t) => [keyOf(t)]);

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

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : 0;
};

const safeText = (s: string) => s.replace(/\s+/g, ' ').slice(0, 80);

/** Deterministic metrics and rule-based candidate findings. Pure: same trades → same output (hashable for caching). */
export function computeInsightInputs(all: TradeRow[], ruleTexts: Map<string, string> = new Map()): Computed {
  const trades = all.filter((t) => Number.isFinite(t.pnl) && t.openDate && Number.isFinite(Date.parse(t.openDate)));
  const byClose = [...trades].sort((a, b) => (closeKey(a) < closeKey(b) ? -1 : closeKey(a) > closeKey(b) ? 1 : 0));
  const byOpen = [...trades].sort((a, b) => (a.openDate < b.openDate ? -1 : a.openDate > b.openDate ? 1 : 0));

  const wins = trades.filter((t) => t.pnl > 0);
  const losses = trades.filter((t) => t.pnl < 0);
  const netPnl = net(trades);
  const fees = round2(trades.reduce((s, t) => s + t.fees, 0));
  const grossPnl = round2(netPnl + fees);
  const grossWin = wins.reduce((s, t) => s + t.pnl, 0);
  const grossLoss = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));
  const avgWin = wins.length ? grossWin / wins.length : null;
  const avgLoss = losses.length ? -grossLoss / losses.length : null;
  const rs = trades.map((t) => rMultiple({ entryPrice: t.entryPrice, stopLoss: t.stopLoss, quantity: t.quantity, multiplier: t.contractMultiplier }, t.pnl)).filter((r): r is number => r != null);

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
  const baseMetricIds = Object.keys(m);

  const candidates: Finding[] = [];
  let seq = 0;
  const add = (f: Omit<Finding, 'id'>) => candidates.push({ id: `c${++seq}`, ...f });

  // Breakdowns: each group with enough trades yields net/winRate/trades metrics and a strength or leak.
  const dims: { id: string; label: string; keyOf: (t: TradeRow) => string | null; name: (k: string) => string }[] = [
    { id: 'setup', label: 'Setup', keyOf: (t) => (t.setupType ? safeText(t.setupType) : null), name: (k) => `setup "${k}"` },
    { id: 'session', label: 'Session', keyOf: (t) => (t.tradingSession ? safeText(t.tradingSession) : null), name: (k) => `${k} session` },
    { id: 'symbol', label: 'Symbol', keyOf: (t) => safeText(t.symbol) || null, name: (k) => k },
    { id: 'asset', label: 'Asset class', keyOf: (t) => t.assetClass, name: (k) => `${k} trades` },
    { id: 'side', label: 'Side', keyOf: (t) => t.side, name: (k) => `${k === 'BUY' ? 'long' : 'short'} trades` },
    { id: 'weekday', label: 'Weekday', keyOf: (t) => WEEKDAYS[ist(t.openDate).getUTCDay()], name: (k) => `trades opened on ${k}s` },
    { id: 'hour', label: 'Hour', keyOf: (t) => `h${pad2(ist(t.openDate).getUTCHours())}`, name: (k) => `trades opened ${k.slice(1)}:00-${pad2((+k.slice(1) + 1) % 24)}:00 IST` },
    { id: 'holding', label: 'Holding time', keyOf: (t) => { const h = holdingMinutes(t); return h == null || h < 0 ? null : holdingBucket(h); }, name: (k) => `trades held ${k}` },
  ];
  for (const d of dims) {
    const groups = group(trades, d.keyOf).sort((a, b) => Math.abs(net(b.trades)) - Math.abs(net(a.trades)));
    for (const g of groups.slice(0, d.id === 'symbol' ? 8 : 12)) {
      if (g.trades.length < 3) continue;
      const base = `${d.id}.${g.key}`;
      const n = net(g.trades);
      m[`${base}.net`] = metric(`Net P&L, ${d.name(g.key)}`, n, 'currency');
      m[`${base}.winRate`] = metric(`Win rate, ${d.name(g.key)}`, winRate(g.trades), 'percent');
      m[`${base}.trades`] = metric(`Number of ${d.name(g.key)}`, g.trades.length, 'count');
      if (g.trades.length < MIN_GROUP) continue;
      if (n < 0) add({ kind: 'leak', title: `Losses in ${d.name(g.key)}`, detail: `${d.name(g.key)}: ${g.trades.length} trades, net ${fmt(n, 'currency')}, win rate ${fmt(winRate(g.trades), 'percent')}.`, metricRef: `${base}.net`, impact: Math.abs(n), tradeIds: sample(g.trades, true) });
      else if (n > 0 && winRate(g.trades) >= 50) add({ kind: 'strength', title: `Profits in ${d.name(g.key)}`, detail: `${d.name(g.key)}: ${g.trades.length} trades, net ${fmt(n, 'currency')}, win rate ${fmt(winRate(g.trades), 'percent')}.`, metricRef: `${base}.net`, impact: n, tradeIds: sample(g.trades, false) });
    }
  }

  // Revenge trades: opened within 15 minutes of a losing close, same IST day.
  const revenge: TradeRow[] = [];
  for (let i = 1; i < byOpen.length; i++) {
    const prev = byOpen[i - 1];
    if (prev.pnl < 0 && prev.closeDate && istDay(prev.closeDate) === istDay(byOpen[i].openDate)) {
      const gap = (Date.parse(byOpen[i].openDate) - Date.parse(prev.closeDate)) / 60000;
      if (gap >= 0 && gap <= REVENGE_MINUTES) revenge.push(byOpen[i]);
    }
  }
  m.revengeTrades = metric('Trades opened within 15 min of a loss', revenge.length, 'count');
  m.revengeNet = metric('Net P&L of those trades', net(revenge), 'currency');
  if (revenge.length >= 3 && net(revenge) < 0) {
    add({ kind: 'leak', title: 'Re-entering right after a loss', detail: `${revenge.length} trades opened within ${REVENGE_MINUTES} minutes of a losing trade closing, net ${fmt(net(revenge), 'currency')}.`, metricRef: 'revengeNet', impact: Math.abs(net(revenge)), tradeIds: sample(revenge, true) });
  }

  // Overtrading: days with more than twice the median number of trades that also lost money.
  const days = group(trades, (t) => istDay(t.openDate));
  const med = median(days.map((d) => d.trades.length));
  const over = days.filter((d) => d.trades.length >= 4 && d.trades.length > 2 * med && net(d.trades) < 0);
  const overTrades = over.flatMap((d) => d.trades);
  m.overtradingDays = metric('Overtrading days (over 2x the usual count, net loss)', over.length, 'count');
  m.overtradingNet = metric('Net P&L on those days', net(overTrades), 'currency');
  if (over.length >= 2) {
    add({ kind: 'pattern', title: 'Overtrading days', detail: `${over.length} days had more than twice your usual ${fmt(med, 'count')} trades and ended in a loss, net ${fmt(net(overTrades), 'currency')} on those days.`, metricRef: 'overtradingNet', impact: Math.abs(net(overTrades)), tradeIds: sample(overTrades, true) });
  }

  // Trades without a stop.
  const noStop = trades.filter((t) => !(t.stopLoss && t.stopLoss > 0));
  m.noStopTrades = metric('Trades without a stop loss', noStop.length, 'count');
  m.noStopNet = metric('Net P&L of trades without a stop', net(noStop), 'currency');
  if (noStop.length >= MIN_GROUP && noStop.length / Math.max(trades.length, 1) >= 0.3) {
    add({ kind: 'leak', title: 'Trades without a stop loss', detail: `${noStop.length} of ${trades.length} trades have no stop loss recorded, net ${fmt(net(noStop), 'currency')}.`, metricRef: 'noStopNet', impact: Math.abs(net(noStop)), tradeIds: sample(noStop, net(noStop) < 0) });
  }

  // Mistake tags and broken rules.
  const mistakeGroups = groupMany(trades, (t) => t.mistakes.map((x) => (x ? safeText(x) : null)));
  for (const g of mistakeGroups) {
    const n = net(g.trades);
    if (g.trades.length >= 2 && n < 0) {
      m[`mistake.${g.key}.net`] = metric(`Net P&L of trades tagged "${g.key}"`, n, 'currency');
      add({ kind: 'leak', title: `Mistake: ${g.key}`, detail: `${g.trades.length} trades tagged "${g.key}" lost ${fmt(Math.abs(n), 'currency')} in total.`, metricRef: `mistake.${g.key}.net`, impact: Math.abs(n), tradeIds: sample(g.trades, true) });
    }
  }
  const ruleGroups = groupMany(trades, (t) => t.brokenRuleIds);
  for (const g of ruleGroups) {
    const text = ruleTexts.get(g.key);
    const n = net(g.trades);
    if (text && g.trades.length >= 2 && n < 0) {
      m[`rule.${g.key}.net`] = metric(`Net P&L when the rule "${safeText(text)}" was broken`, n, 'currency');
      add({ kind: 'leak', title: `Broken rule: ${safeText(text)}`, detail: `The rule "${safeText(text)}" was broken on ${g.trades.length} trades, net ${fmt(n, 'currency')}.`, metricRef: `rule.${g.key}.net`, impact: Math.abs(n), tradeIds: sample(g.trades, true) });
    }
  }

  if (fees > 0 && grossPnl > 0 && (fees / grossPnl) * 100 >= 15) {
    add({ kind: 'leak', title: 'Fees take a large share of profit', detail: `Fees and charges of ${fmt(fees, 'currency')} are ${fmt((fees / grossPnl) * 100, 'percent')} of gross profit.`, metricRef: 'fees', impact: fees, tradeIds: sample(trades.filter((t) => t.fees > 0), true) });
  }
  const lossStreak = m.maxLossStreak.value ?? 0;
  if (lossStreak >= 4) {
    add({ kind: 'pattern', title: 'Long losing streak', detail: `Your longest losing streak is ${lossStreak} trades in a row.`, metricRef: 'maxLossStreak', impact: lossStreak, tradeIds: sample(losses, true) });
  }

  candidates.sort((a, b) => b.impact - a.impact);
  const top = candidates.slice(0, MAX_CANDIDATES).map((c, i) => ({ ...c, id: `c${i + 1}` }));

  const hash = createHash('sha256')
    .update(JSON.stringify({ b: baseMetricIds.map((k) => m[k].value), c: top.map((c) => [c.kind, c.metricRef, c.impact, c.tradeIds]) }))
    .digest('hex');
  return { metrics: m, baseMetricIds, candidates: top, tradeIds: new Set(trades.map((t) => t.id)), hash };
}
