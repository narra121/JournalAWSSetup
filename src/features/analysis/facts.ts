import { dayOf, weekdayOf } from '../../shared/timezone';
import type { TradeRow } from '../trades-repo';

/** Losses below this R went past the stop (5% allowance for slippage, CONTRACT I2). */
export const BEYOND_STOP_R = -1.05;
/** Below this |R| the money at risk is taken from prices × quantity instead of P&L ÷ R (P&L ÷ ~0 is noise). */
const MIN_R_FOR_RISK = 0.05;

/** Sequence and derived facts of one trade (research report §6 D4). */
export interface TradeFacts {
  t: TradeRow;
  /** position in open-time order, 0 = oldest */
  index: number;
  openMs: number;
  /** null when the trade has no close date */
  closeMs: number | null;
  /** local calendar day the trade opened / closed (closed = opened when no close date) */
  day: string;
  closeDay: string;
  /** 0 = Sunday */
  weekday: number;
  /** local hour and minute of day; null for a date-only open date */
  hour: number | null;
  minuteOfDay: number | null;
  /** realised R (CONTRACT I2), before fees */
  r: number | null;
  /** P&L before fees */
  gross: number;
  /** money lost if the stop had been hit; null without a stop */
  risk: number | null;
  holdingMin: number | null;
  /** planned reward ÷ risk, from the take-profit price, else the stored riskRewardRatio */
  plannedRR: number | null;
  /** 1 = first trade opened that local day */
  tradeNumber: number;
  /** trades opened that local day */
  dayTrades: number;
  /** the trade whose result was the latest one known when this one opened (closed at or before its open) */
  prev: { id: string; pnl: number; sameDay: boolean; minutesSinceClose: number | null } | null;
  /** risk ÷ the median risk of the period */
  riskVsMedian: number | null;
}

const hasTime = (iso: string | null | undefined): iso is string => !!iso && iso.includes('T');
const isUtc = (tz: string) => tz === 'UTC' || tz === 'Etc/UTC' || tz === 'GMT';

const clock = new Map<string, Intl.DateTimeFormat>();
/** Minutes after local midnight of an instant in `tz`. */
export function localMinuteOfDay(ms: number, tz: string): number {
  if (isUtc(tz)) {
    const d = new Date(ms);
    return d.getUTCHours() * 60 + d.getUTCMinutes();
  }
  let f = clock.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', hour: '2-digit', minute: '2-digit' });
    clock.set(tz, f);
  }
  const p = Object.fromEntries(f.formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return (Number(p.hour) % 24) * 60 + Number(p.minute);
}

/** Realised R from prices (CONTRACT I2): null without a stop, with stop = entry, or with a missing price. */
export function realisedR(t: Pick<TradeRow, 'side' | 'entryPrice' | 'exitPrice' | 'stopLoss' | 'closeDate'>): number | null {
  const { entryPrice: entry, exitPrice: exit, stopLoss: stop } = t;
  if (stop == null || !(stop > 0) || !(entry > 0) || stop === entry || !Number.isFinite(exit) || exit < 0) return null;
  // toTradeRow stores a missing exit price as 0; 0 is a real price only for a closed trade (an option that expired).
  if (exit === 0 && !t.closeDate) return null;
  return ((t.side === 'SELL' ? -1 : 1) * (exit - entry)) / Math.abs(entry - stop);
}

/** Planned R:R: from the take-profit price when it lies on the profit side of the entry, else the stored ratio. */
export function plannedRR(t: Pick<TradeRow, 'side' | 'entryPrice' | 'stopLoss' | 'takeProfit' | 'riskRewardRatio'>): number | null {
  const { entryPrice: entry, stopLoss: stop, takeProfit: tp } = t;
  if (tp != null && tp > 0 && stop != null && stop > 0 && entry > 0 && stop !== entry) {
    const reward = (t.side === 'SELL' ? -1 : 1) * (tp - entry);
    if (reward > 0) return reward / Math.abs(entry - stop);
  }
  return t.riskRewardRatio != null && Number.isFinite(t.riskRewardRatio) && t.riskRewardRatio > 0 ? t.riskRewardRatio : null;
}

export const median = (xs: number[]): number | null => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/** Trades with a usable P&L and open date, in open-time order (ties by id), with their facts. */
export function tradeFacts(all: TradeRow[], timeZone: string): TradeFacts[] {
  const trades = all
    .filter((t) => Number.isFinite(t.pnl) && t.openDate && Number.isFinite(Date.parse(t.openDate)))
    .map((t) => ({ t, openMs: Date.parse(t.openDate) }))
    .sort((a, b) => a.openMs - b.openMs || (a.t.id < b.t.id ? -1 : a.t.id > b.t.id ? 1 : 0));

  const facts: TradeFacts[] = trades.map(({ t, openMs }, index) => {
    const parsedClose = t.closeDate ? Date.parse(t.closeDate) : NaN;
    const closeMs = Number.isFinite(parsedClose) ? parsedClose : null;
    const day = dayOf(t.openDate, timeZone);
    const r = realisedR(t);
    const gross = t.pnl + (Number.isFinite(t.fees) ? t.fees : 0);
    let risk: number | null = null;
    if (r != null && Math.abs(r) >= MIN_R_FOR_RISK) risk = Math.abs(gross / r);
    else if (r != null && t.quantity > 0) risk = Math.abs(t.entryPrice - t.stopLoss!) * t.quantity * (t.contractMultiplier && t.contractMultiplier > 0 ? t.contractMultiplier : 1);
    const holding = hasTime(t.openDate) && hasTime(t.closeDate) && closeMs != null ? (closeMs - openMs) / 60_000 : null;
    const minuteOfDay = hasTime(t.openDate) ? localMinuteOfDay(openMs, timeZone) : null;
    return {
      t, index, openMs, closeMs, day,
      closeDay: t.closeDate && closeMs != null ? dayOf(t.closeDate, timeZone) : day,
      weekday: weekdayOf(day),
      hour: minuteOfDay == null ? null : Math.floor(minuteOfDay / 60),
      minuteOfDay,
      r, gross, risk,
      holdingMin: holding != null && holding >= 0 ? holding : null,
      plannedRR: plannedRR(t),
      tradeNumber: 0, dayTrades: 0, prev: null, riskVsMedian: null,
    };
  });

  for (const list of groupByDay(facts).values()) list.forEach((f, i) => { f.tradeNumber = i + 1; f.dayTrades = list.length; });

  // Latest result known at each open: walk closes in close order alongside opens in open order.
  const closed = facts.map((f) => ({ f, at: f.closeMs ?? f.openMs })).sort((a, b) => a.at - b.at || a.f.index - b.f.index);
  const known: TradeFacts[] = [];
  let next = 0;
  for (const f of facts) {
    while (next < closed.length && closed[next].at <= f.openMs) known.push(closed[next++].f);
    // A zero-length trade opened at the same instant but later in open order is not known yet.
    let k = known.length - 1;
    while (k >= 0 && known[k].index >= f.index) k--;
    if (k < 0) continue;
    const p = known[k];
    const sameDay = p.closeDay === f.day;
    f.prev = { id: p.t.id, pnl: p.t.pnl, sameDay, minutesSinceClose: hasTime(p.t.closeDate) && hasTime(f.t.openDate) && p.closeMs != null ? (f.openMs - p.closeMs) / 60_000 : null };
  }

  const med = median(facts.map((f) => f.risk).filter((x): x is number => x != null && x > 0));
  if (med) for (const f of facts) f.riskVsMedian = f.risk != null ? f.risk / med : null;
  return facts;
}

/** Facts of the trades (same day, earlier in open order) whose result was known when `f` opened. */
export function knownBefore(f: TradeFacts, sameDay: TradeFacts[]): TradeFacts[] {
  return sameDay.filter((g) => g.index < f.index && (g.closeMs ?? g.openMs) <= f.openMs);
}

/** Facts by local open day, each list in open order. */
export function groupByDay(facts: TradeFacts[]): Map<string, TradeFacts[]> {
  const m = new Map<string, TradeFacts[]>();
  for (const f of facts) (m.get(f.day) ?? m.set(f.day, []).get(f.day)!).push(f);
  return m;
}
