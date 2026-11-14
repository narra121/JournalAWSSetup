import { REENTRY_MINUTES, TARGET_REACHED_SHARE } from '../analysis/detectors';
import { MIN_VERDICT_TRADES } from '../analysis/evidence';
import { BEYOND_STOP_R, median, tradeFacts, type TradeFacts } from '../analysis/facts';
import { resolveTimeZone } from '../analysis/load';
import type { Focus } from '../focus/types';
import { dayOf } from '../../shared/timezone';
import type { TradeRow } from '../trades-repo';
import { money, plural, rText } from './format';
import { addDays } from './history';
import type { LoadDeps } from './load';
import { BASELINE_DAYS } from './review';

export const RISK_MULTIPLE = 1.5;
/** Fewer trades with a stop than this and the trader's usual risk is not known well enough to judge one trade. */
const MIN_RISK_HISTORY = 5;

export type CheckId = 'stopSet' | 'riskWithinUsual' | 'lossKeptOrTarget' | 'notAfterLoss' | 'withinTradeCap' | 'setupHistory';
export interface DebriefCheck {
  id: CheckId;
  label: string;
  state: 'met' | 'notMet' | 'notApplicable';
  detail: string;
}
export interface Debrief {
  tradeId: string;
  checks: DebriefCheck[];
  /** checks met, and checks that applied (met + not met): "5 of 6 checks met" */
  metCount: number;
  total: number;
  currency: string | null;
  timeZone: string;
}

const LABELS: Record<CheckId, string> = {
  stopSet: 'A stop was set',
  riskWithinUsual: `Risk within ${RISK_MULTIPLE}× your median`,
  lossKeptOrTarget: 'Loss kept to the stop, or target reached',
  notAfterLoss: `Not opened within ${REENTRY_MINUTES} minutes of a loss`,
  withinTradeCap: 'Trade number inside your daily cap',
  setupHistory: 'Setup has enough history to judge',
};

/** The research report §5.4 checks of one trade, judged against `facts` (the trade's account, the 90 days up to its day). */
export function debriefChecks(facts: TradeFacts[], f: TradeFacts, focus: Focus | null, currency: string | null): Pick<Debrief, 'checks' | 'metCount' | 'total'> {
  const t = f.t;
  const out: DebriefCheck[] = [];
  const add = (id: CheckId, state: DebriefCheck['state'], detail: string) => out.push({ id, label: LABELS[id], state, detail });

  const hasStop = t.stopLoss != null && t.stopLoss > 0;
  add('stopSet', hasStop ? 'met' : 'notMet', hasStop ? `Stop at ${t.stopLoss}.` : 'No stop recorded.');

  const risks = facts.map((x) => x.risk).filter((x): x is number => x != null && x > 0);
  const med = median(risks);
  if (f.risk == null || med == null) add('riskWithinUsual', 'notApplicable', 'No stop, so the money at risk is unknown.');
  else if (risks.length < MIN_RISK_HISTORY) add('riskWithinUsual', 'notApplicable', `Only ${plural(risks.length, 'trade')} with a stop in the last ${BASELINE_DAYS} days: too few to know your usual risk.`);
  else {
    const multiple = f.risk / med;
    // Below 0.1× one decimal would print 0.0×, which reads as nothing risked.
    const times = multiple >= 0.1 ? multiple.toFixed(1) : multiple.toPrecision(1);
    add('riskWithinUsual', multiple <= RISK_MULTIPLE ? 'met' : 'notMet', `Risked ${money(f.risk, currency)}, ${times}× your median of ${money(med, currency)} over the last ${BASELINE_DAYS} days.`);
  }

  if (t.pnl < 0) {
    if (f.r == null) add('lossKeptOrTarget', 'notApplicable', 'A loss without a stop: it cannot be measured against one.');
    else add('lossKeptOrTarget', f.r >= BEYOND_STOP_R ? 'met' : 'notMet', f.r >= BEYOND_STOP_R ? `Lost ${rText(f.r)}, within the stop.` : `Lost ${rText(f.r)}, past the stop.`);
  } else if (t.pnl > 0 && f.r != null && f.plannedRR != null) {
    const reached = f.r >= TARGET_REACHED_SHARE * f.plannedRR;
    add('lossKeptOrTarget', reached ? 'met' : 'notMet', `${reached ? 'Reached the target' : 'Closed before the target'}: ${rText(f.r)} of ${f.plannedRR.toFixed(2)}R planned.`);
  } else add('lossKeptOrTarget', 'notApplicable', t.pnl > 0 ? 'A winner without a target or a stop to measure it against.' : 'Closed at break-even.');

  const p = f.prev;
  if (f.minuteOfDay == null) add('notAfterLoss', 'notApplicable', 'The trade has no time of day.');
  else if (p && p.pnl < 0 && p.sameDay && p.minutesSinceClose == null) add('notAfterLoss', 'notApplicable', 'The losing trade before it has no close time.');
  else if (p && p.pnl < 0 && p.sameDay && p.minutesSinceClose! <= REENTRY_MINUTES) add('notAfterLoss', 'notMet', `Opened ${Math.round(p.minutesSinceClose!)} minutes after a losing trade closed.`);
  else add('notAfterLoss', 'met', p && p.pnl < 0 && p.sameDay ? `Opened ${Math.round(p.minutesSinceClose!)} minutes after the last loss closed.` : 'No losing trade closed shortly before it.');

  const cap = focus?.rule.kind === 'maxTradesPerDay' ? focus.rule.n : null;
  if (cap == null) add('withinTradeCap', 'notApplicable', 'No daily trade cap is set as your focus.');
  else add('withinTradeCap', f.tradeNumber <= cap ? 'met' : 'notMet', `Trade ${f.tradeNumber} of the day; your cap is ${cap}.`);

  const setup = t.setupType?.trim().toLowerCase();
  if (!setup) add('setupHistory', 'notApplicable', 'No setup recorded.');
  else {
    const n = facts.filter((x) => x.openMs <= f.openMs && x.t.setupType?.trim().toLowerCase() === setup).length;
    add('setupHistory', n >= MIN_VERDICT_TRADES ? 'met' : 'notMet', n >= MIN_VERDICT_TRADES
      ? `${plural(n, 'trade')} of "${t.setupType!.trim()}" in the last ${BASELINE_DAYS} days: enough to judge it.`
      : `${plural(n, 'trade')} of "${t.setupType!.trim()}" in the last ${BASELINE_DAYS} days; ${MIN_VERDICT_TRADES} are needed to judge it.`);
  }

  const metCount = out.filter((c) => c.state === 'met').length;
  return { checks: out, metCount, total: out.filter((c) => c.state !== 'notApplicable').length };
}

export interface DebriefDeps extends LoadDeps {
  tradeById(userId: string, tradeId: string): Promise<TradeRow | null>;
}

/** Loads the trade and its context; null when the trade does not exist (or was deleted). */
export async function debriefTrade(deps: DebriefDeps, userId: string, tradeId: string, focus: Focus | null): Promise<Debrief | null> {
  const [trade, zone, accounts] = await Promise.all([deps.tradeById(userId, tradeId), deps.timeZone(userId), deps.accounts(userId)]);
  if (!trade || !trade.openDate || !Number.isFinite(Date.parse(trade.openDate))) return null;
  const timeZone = resolveTimeZone(zone);
  const day = dayOf(trade.openDate, timeZone);
  const scope = { timeZone, accountId: trade.accountId };
  const [before, sameDay] = await Promise.all([
    deps.trades.loadTrades(userId, { ...scope, from: addDays(day, -BASELINE_DAYS), to: addDays(day, -1) }),
    deps.trades.loadTrades(userId, { ...scope, from: day, to: day }),
  ]);
  const rows = new Map<string, TradeRow>([...before.trades, ...sameDay.trades].map((t) => [t.id, t]));
  rows.set(trade.id, trade);
  const facts = tradeFacts([...rows.values()], timeZone);
  const f = facts.find((x) => x.t.id === trade.id);
  if (!f) return null;
  const currency = accounts.find((a) => a.accountId === trade.accountId)?.currency ?? null;
  return { tradeId, ...debriefChecks(facts, f, focus, currency), currency, timeZone };
}
