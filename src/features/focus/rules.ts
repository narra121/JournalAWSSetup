import { beyondStopAmount } from '../analysis/detectors';
import { BEYOND_STOP_R, type TradeFacts } from '../analysis/facts';
import { netOf } from '../analysis/segments';
import type { Dimension } from '../analysis/types';
import { blockedBy, parseWhatIfRule } from '../analysis/whatif';
import type { FocusCheck, FocusRule } from './types';

export const MAX_FOCUS_TEXT = 200;
const round2 = (v: number) => Math.round((v + Number.EPSILON) * 100) / 100;

/** A focus rule from untrusted JSON; a message when it is not one. */
export function parseFocusRule(x: unknown): FocusRule | string {
  const o = x as Record<string, unknown> | null;
  if (!o || typeof o !== 'object') return 'rule must be an object.';
  if (o.kind === 'exitAtStop' || o.kind === 'setStop') return { kind: o.kind };
  if (o.kind === 'pauseAfterLoss') {
    return typeof o.minutes === 'number' && Number.isInteger(o.minutes) && o.minutes >= 1 && o.minutes <= 240
      ? { kind: 'pauseAfterLoss', minutes: o.minutes }
      : 'minutes must be a whole number from 1 to 240.';
  }
  const r = parseWhatIfRule(x);
  return typeof r === 'string' ? `${r.replace(/\.$/, '')} (or kind exitAtStop, setStop, pauseAfterLoss).` : r;
}

const SEGMENT_PHRASE: Partial<Record<Dimension, (name: string) => string>> = {
  symbol: (n) => `If the trade is in ${n}, I skip it.`,
  setup: (n) => `If the setup is ${n}, I skip it.`,
  session: (n) => `If it is the ${n} session, I don't trade.`,
  direction: (n) => `If the trade is a ${n.toLowerCase()} trade, I skip it.`,
  weekday: (n) => `If it is ${n}, I don't trade.`,
  hour: (n) => `If the time is ${n}, I don't open a trade.`,
  marketCondition: (n) => `If the market is ${n}, I don't trade.`,
  newsEvent: (n) => `If "${n}" is on the calendar, I don't trade.`,
  tag: (n) => `If the trade would be tagged "${n}", I skip it.`,
  plannedRR: (n) => `If a trade's plan is ${n.replace(/^Planned /, '')} of reward, I skip it.`,
  optionType: (n) => `If the trade is a ${n === 'Calls' ? 'call' : 'put'}, I skip it.`,
  expiryDay: () => "If it is the option's expiry day, I don't open an options trade.",
};

/** The if-then sentence of a rule; `segmentName` is the display name of a skipped segment. */
export function focusRuleText(rule: FocusRule, segmentName?: string): string {
  switch (rule.kind) {
    case 'exitAtStop': return 'If price reaches my stop, I exit.';
    case 'setStop': return "If I can't say where my stop is, I don't enter.";
    case 'pauseAfterLoss': return `If a trade closes at a loss, I wait ${rule.minutes} minutes before the next entry.`;
    case 'stopAfterLosses': return rule.n === 1 ? 'If I close a losing trade, I stop trading for the day.' : `If I have closed ${rule.n} losing trades today, I stop trading for the day.`;
    case 'maxTradesPerDay': return rule.n === 1 ? 'If I have taken one trade today, I stop for the day.' : `If I have taken ${rule.n} trades today, I stop for the day.`;
    case 'noTradesAfter': return `If it is ${rule.time} or later, I don't open a trade.`;
    case 'maxRiskMultiple': return `If a trade would risk more than ${rule.multiple}× my usual amount, I cut the size.`;
    case 'skipSegment': {
      const name = segmentName ?? rule.key;
      return SEGMENT_PHRASE[rule.dimension]?.(name) ?? `If the trade is ${name}, I skip it.`;
    }
  }
}

/** The trades that broke the rule. Facts carry the whole day and the trader's usual risk, so pass the full context. */
export function brokenBy(facts: TradeFacts[], rule: FocusRule): Set<TradeFacts> {
  switch (rule.kind) {
    case 'exitAtStop': return new Set(facts.filter((f) => f.r != null && f.r < BEYOND_STOP_R));
    case 'setStop': return new Set(facts.filter((f) => f.t.stopLoss == null || !(f.t.stopLoss > 0)));
    case 'pauseAfterLoss':
      return new Set(facts.filter((f) => f.prev && f.prev.pnl < 0 && f.prev.sameDay && f.prev.minutesSinceClose != null && f.prev.minutesSinceClose <= rule.minutes));
    default: return blockedBy(facts, rule);
  }
}

/** Kept/broken over the facts for which `inScope` holds; `facts` is the context the rule is judged in. */
export function focusCheck(facts: TradeFacts[], rule: FocusRule, inScope: (f: TradeFacts) => boolean): FocusCheck {
  const broken = brokenBy(facts, rule);
  const scope = facts.filter(inScope);
  const checked = rule.kind === 'exitAtStop' ? scope.filter((f) => f.t.pnl < 0 && f.r != null) : scope;
  const breaks = checked.filter((f) => broken.has(f));
  const brokenNet = netOf(breaks);
  const cost = rule.kind === 'exitAtStop' ? breaks.reduce((s, f) => s + beyondStopAmount(f), 0) : Math.max(0, -brokenNet);
  return {
    checked: checked.length,
    kept: checked.length - breaks.length,
    broken: breaks.length,
    brokenTradeIds: breaks.map((f) => f.t.id),
    brokenNet,
    cost: round2(cost),
  };
}
