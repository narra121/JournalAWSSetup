import { dayOf, weekdayOf } from '../../shared/timezone';
import { computeChatMetrics } from '../insights/metrics';
import type { Insight } from '../insights/store';
import type { TradeRow } from '../trades-repo';

export const MAX_CONTEXT_TRADES = 30;
export const DEFAULT_PERIOD_DAYS = 90;
const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Period the chat analyses: the linked insight's, else the last 90 days ending today in the user's time zone. */
export function chatPeriod(insight: Insight | null, now: Date, timeZone: string): { from: string; to: string; accountId: string | null } {
  if (insight) return { ...insight.period, accountId: insight.accountId };
  const to = dayOf(now.toISOString(), timeZone);
  const from = new Date(Date.parse(`${to}T00:00:00Z`) - DEFAULT_PERIOD_DAYS * 86_400_000).toISOString().slice(0, 10);
  return { from, to, accountId: null };
}

/** Trades the question refers to (symbol, setup, session, tag, mistake or weekday), else best/worst/latest 10. */
export function selectTrades(question: string, trades: TradeRow[], timeZone: string): TradeRow[] {
  const q = question.toLowerCase();
  const mentioned = trades.filter((t) => {
    const terms = [t.symbol, t.setupType, t.tradingSession, ...t.tags, ...t.mistakes].filter((x): x is string => !!x && x.length >= 3).map((x) => x.toLowerCase());
    if (terms.some((x) => new RegExp(`(^|[^a-z0-9])${escapeRe(x)}($|[^a-z0-9])`).test(q))) return true;
    return q.includes(WEEKDAYS[weekdayOf(dayOf(t.openDate, timeZone))]);
  });
  if (mentioned.length) {
    return mentioned.length <= MAX_CONTEXT_TRADES ? mentioned : [...mentioned].sort((a, b) => Math.abs(b.pnl) - Math.abs(a.pnl)).slice(0, MAX_CONTEXT_TRADES);
  }
  const byPnl = [...trades].sort((a, b) => b.pnl - a.pnl);
  const pick = new Map<string, TradeRow>();
  for (const t of [...byPnl.slice(0, 10), ...byPnl.slice(-10), ...[...trades].sort((a, b) => (a.openDate < b.openDate ? 1 : -1)).slice(0, 10)]) pick.set(t.id, t);
  return [...pick.values()];
}

export interface ChatContext {
  text: string;
  /** ids of every trade loaded for the period; a cited id outside this set is never linked. */
  knownTradeIds: Set<string>;
}

export interface ContextOptions {
  timeZone: string;
  currency: string | null;
  /** today in the user's time zone, so the model can resolve "last week" for compare */
  today: string;
  truncated?: boolean;
}

/** Compact JSON data block appended to the system instruction. No notes, lessons, images, emails or account names. */
export function buildChatContext(question: string, trades: TradeRow[], insight: Insight | null, period: { from: string; to: string }, opts: ContextOptions): ChatContext {
  const c = computeChatMetrics(trades);
  const metrics = Object.fromEntries(c.baseMetricIds.map((id) => [id, `${c.metrics[id].label}: ${c.metrics[id].display}`]));
  const picked = selectTrades(question, trades, opts.timeZone);
  const data = {
    period, today: opts.today, timeZone: opts.timeZone, currency: opts.currency ?? 'unknown',
    ...(opts.truncated ? { warning: `Partial data: only the oldest ${trades.length} trades of this period were loaded. Say so when numbers could be affected.` } : {}),
    metrics,
    ...(insight ? { insight: { summary: insight.summary, sections: insight.sections.map((s) => ({ kind: s.kind, title: s.title })) } } : {}),
    trades: picked.map((t) => ({
      id: t.id, day: dayOf(t.openDate, opts.timeZone), symbol: t.symbol, side: t.side, pnl: t.pnl,
      ...(t.setupType ? { setup: t.setupType } : {}), ...(t.tradingSession ? { session: t.tradingSession } : {}),
      ...(t.mistakes.length ? { mistakes: t.mistakes } : {}),
    })),
  };
  return { text: `DATA (JSON):\n${JSON.stringify(data)}`, knownTradeIds: new Set([...c.tradeIds, ...trades.map((t) => t.id)]) };
}
