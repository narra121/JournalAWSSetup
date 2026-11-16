import { mean, sampleLabel, verdict } from './evidence';
import { BEYOND_STOP_R, groupByDay, knownBefore, median, type TradeFacts } from './facts';
import { idsOf, netOf, r4, rsOf } from './segments';
import { DETECTOR_IDS, type Detector, type DetectorId } from './types';
// Symbol format ("$146.50", "₹110.00"), as the app prints the figures beside these sentences.
import { money as moneyText } from '../insights/format';

const money = (v: number, currency?: string | null) => moneyText(v, currency ?? null);

export const REENTRY_MINUTES = 15;
export const SIZE_UP_MULTIPLE = 1.5;
export const OVERTRADING_MULTIPLE = 2;
const OVERTRADING_MIN_TRADES = 4;
/** A winner reached its target when its R is at least this share of the planned R:R. */
export const TARGET_REACHED_SHARE = 0.95;

export interface DetectorOptions {
  /** closed loss of a day (positive amount) after which the trader stops; null = not set */
  dailyLossLimit?: number | null;
  /** ruleId → rule text (one rule is stored once per period, so several ids share a text) */
  ruleTexts?: Map<string, string>;
  /** currency code used in the sentences */
  currency?: string | null;
}

const rText = (v: number | null) => (v == null ? 'no R (no stop)' : `${v >= 0 ? '+' : '−'}${Math.abs(v).toFixed(2)}R`);
const minutes = (v: number | null) => (v == null ? 'n/a' : `${Math.round(v)} min`);
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/**
 * The fixed behaviour list of research report §4.6: one row per id in DETECTOR_IDS order, each judged against its
 * comparison group with `candidates` = the length of that list. Facts must come from tradeFacts (open order).
 */
export function computeDetectors(facts: TradeFacts[], opts: DetectorOptions = {}): Detector[] {
  const cur = opts.currency;
  const candidates = DETECTOR_IDS.length;
  const flagged = new Map<DetectorId, { members: TradeFacts[]; normal: TradeFacts[]; useMoney?: boolean; detail: string; title: string }>();
  const rest = (members: TradeFacts[], within: TradeFacts[] = facts) => {
    const s = new Set(members);
    return within.filter((f) => !s.has(f));
  };
  const days = groupByDay(facts);

  {
    const members = facts.filter((f) => f.prev && f.prev.pnl < 0 && f.prev.sameDay && f.prev.minutesSinceClose != null && f.prev.minutesSinceClose <= REENTRY_MINUTES);
    flagged.set('reentryAfterLoss', { title: 'Re-entry after a loss', members, normal: rest(members), detail: `${plural(members.length, 'trade')} opened within ${REENTRY_MINUTES} minutes of a losing trade closing the same day, net ${money(netOf(members), cur)}; compared with all other trades.` });
  }
  {
    const members = facts.filter((f) => f.prev?.sameDay && f.prev.pnl < 0);
    const afterWin = facts.filter((f) => f.prev?.sameDay && f.prev.pnl > 0);
    flagged.set('afterLoss', { title: 'Next trade after a loss', members, normal: afterWin, detail: `After a loss the same day: ${plural(members.length, 'trade')}, net ${money(netOf(members), cur)}, ${rText(r4(mean(rsOf(members))))} on average. After a win: ${plural(afterWin.length, 'trade')}, net ${money(netOf(afterWin), cur)}, ${rText(r4(mean(rsOf(afterWin))))} on average.` });
  }
  {
    const medRisk = median(facts.map((f) => f.risk).filter((x): x is number => x != null && x > 0));
    const members = facts.filter((f) => f.prev && f.prev.pnl < 0 && f.riskVsMedian != null && f.riskVsMedian > SIZE_UP_MULTIPLE);
    const withRisk = facts.filter((f) => f.prev && f.prev.pnl < 0 && f.riskVsMedian != null);
    flagged.set('sizeUpAfterLoss', { title: 'Size up after a loss', members, normal: rest(members, facts.filter((f) => f.riskVsMedian != null)), detail: medRisk == null ? 'No trade has a stop, so the money at risk is unknown.' : `${members.length} of ${plural(withRisk.length, 'trade')} that followed a loss risked more than ${SIZE_UP_MULTIPLE}× your median of ${money(medRisk, cur)}, net ${money(netOf(members), cur)}.` });
  }
  {
    const members = facts.filter((f) => f.tradeNumber >= 2);
    const parts = [1, 2, 3, 4].map((k) => {
      const g = facts.filter((f) => (k === 4 ? f.tradeNumber >= 4 : f.tradeNumber === k));
      return g.length ? `${k === 4 ? '4th+' : ['1st', '2nd', '3rd'][k - 1]}: ${plural(g.length, 'trade')}, ${rText(r4(mean(rsOf(g))))}` : null;
    }).filter(Boolean);
    flagged.set('tradeNumber', { title: 'Later trades of the day', members, normal: rest(members), detail: `Second and later trades of a day against first trades. ${parts.join('; ')}.` });
  }
  {
    const counts = [...days.values()].map((d) => d.length);
    const med = median(counts) ?? 0;
    const heavy = [...days.values()].filter((d) => d.length >= OVERTRADING_MIN_TRADES && d.length > OVERTRADING_MULTIPLE * med);
    const members = heavy.flat();
    flagged.set('overtradingDay', { title: 'Overtrading days', members, normal: rest(members), detail: `${plural(heavy.length, 'day')} had more than ${OVERTRADING_MULTIPLE}× your usual ${med} trades a day (and at least ${OVERTRADING_MIN_TRADES}); those days' ${plural(members.length, 'trade')} made ${money(netOf(members), cur)}.` });
  }
  {
    const members = facts.filter((f) => f.r != null && f.r < BEYOND_STOP_R);
    const losers = facts.filter((f) => f.t.pnl < 0).length;
    const beyond = members.reduce((s, f) => s + beyondStopAmount(f), 0);
    flagged.set('beyondStop', { title: 'Losses beyond the stop', members, normal: rest(members), detail: `${members.length} of ${plural(losers, 'losing trade')} ended past the planned risk (below −1.05R); the part beyond the stop cost ${money(beyond, cur)}.` });
  }
  {
    const members = facts.filter((f) => f.t.stopLoss == null || !(f.t.stopLoss > 0));
    flagged.set('noStop', { title: 'No stop recorded', members, normal: rest(members), useMoney: true, detail: `${members.length} of ${plural(facts.length, 'trade')} have no stop loss recorded, net ${money(netOf(members), cur)}. Without a stop there is no R, so these are compared on P&L.` });
  }
  {
    const winners = facts.filter((f) => f.t.pnl > 0 && f.r != null && f.plannedRR != null);
    const members = winners.filter((f) => f.r! < TARGET_REACHED_SHARE * f.plannedRR!);
    const reached = rest(members, winners);
    const planned = mean(members.map((f) => f.plannedRR!));
    flagged.set('targetNotReached', { title: 'Winners closed before the target', members, normal: reached, detail: `${members.length} of ${plural(winners.length, 'winner')} with a planned R:R closed before the target${planned == null ? '' : `: planned ${planned.toFixed(2)}R, captured ${rText(r4(mean(rsOf(members))))} on average`}; compared with winners that reached it.` });
  }
  {
    const winHold = median(facts.filter((f) => f.t.pnl > 0 && f.holdingMin != null).map((f) => f.holdingMin!));
    const loseHold = median(facts.filter((f) => f.t.pnl < 0 && f.holdingMin != null).map((f) => f.holdingMin!));
    const losers = facts.filter((f) => f.t.pnl < 0 && f.holdingMin != null);
    const members = winHold == null ? [] : losers.filter((f) => f.holdingMin! > winHold);
    flagged.set('losersHeldLonger', { title: 'Losers held longer than winners', members, normal: rest(members, losers), detail: `Median holding time: winners ${minutes(winHold)}, losers ${minutes(loseHold)}. ${members.length} of ${plural(losers.length, 'losing trade')} stayed open longer than your typical winner; compared with your other losing trades.` });
  }
  {
    const fees = facts.reduce((s, f) => s + f.t.fees, 0);
    const gross = facts.reduce((s, f) => s + f.gross, 0);
    const members = facts.filter((f) => f.gross > 0 && f.t.fees >= f.gross);
    const share = gross > 0 ? `, ${((fees / gross) * 100).toFixed(1)}% of the gross profit of ${money(gross, cur)}` : '; there was no gross profit';
    flagged.set('fees', { title: 'Fees and charges', members, normal: rest(members), useMoney: true, detail: `Fees and charges of ${money(fees, cur)} (${money(facts.length ? fees / facts.length : 0, cur)} a trade)${share}. ${plural(members.length, 'trade')} made a gross profit no larger than their charges.` });
  }
  {
    const texts = opts.ruleTexts ?? new Map<string, string>();
    const members = facts.filter((f) => f.t.brokenRuleIds.length > 0);
    // One rule has an id per period: count by its text.
    const byRule = new Map<string, { name: string; n: number }>();
    for (const f of members) {
      const names = new Map<string, string>();
      for (const id of f.t.brokenRuleIds) {
        const name = (texts.get(id) ?? 'a rule that no longer exists').replace(/\s+/g, ' ').trim().slice(0, 80);
        if (!names.has(name.toLowerCase())) names.set(name.toLowerCase(), name);
      }
      for (const [k, name] of names) byRule.set(k, { name: byRule.get(k)?.name ?? name, n: (byRule.get(k)?.n ?? 0) + 1 });
    }
    const top = [...byRule.values()].sort((a, b) => b.n - a.n).slice(0, 3).map((r) => `"${r.name}" ${r.n}×`);
    flagged.set('brokenRule', { title: 'Broken rules', members, normal: rest(members), detail: `${plural(members.length, 'trade')} broke at least one rule, net ${money(netOf(members), cur)}${top.length ? ` (${top.join(', ')})` : ''}; compared with trades that broke none.` });
  }
  {
    const limit = opts.dailyLossLimit != null && opts.dailyLossLimit > 0 ? opts.dailyLossLimit : null;
    const members: TradeFacts[] = [];
    if (limit != null) {
      for (const list of days.values()) {
        for (const f of list) if (knownBefore(f, list).reduce((s, g) => s + g.t.pnl, 0) <= -limit) members.push(f);
      }
      members.sort((a, b) => a.index - b.index);
    }
    flagged.set('afterDailyLimit', { title: 'Trades after the daily loss limit', members, normal: rest(members), detail: limit == null ? 'No daily loss limit is set, so this cannot be checked.' : `${plural(members.length, 'trade')} opened after the day's closed loss had reached your limit of ${money(limit, cur)}, net ${money(netOf(members), cur)}.` });
  }
  {
    const options = facts.filter((f) => (f.t.optionType != null || f.t.assetClass?.toLowerCase() === 'options') && f.t.expiry);
    const members = options.filter((f) => f.t.expiry!.slice(0, 10) === f.day);
    flagged.set('expiryDay', { title: 'Options on expiry day', members, normal: rest(members, options), detail: options.length ? `${members.length} of ${plural(options.length, 'options trade')} were opened on their expiry day, net ${money(netOf(members), cur)}; compared with options trades on other days.` : 'No options trade with an expiry date in this period.' });
  }

  return DETECTOR_IDS.map((id) => {
    const d = flagged.get(id)!;
    const a = d.useMoney ? d.members.map((f) => f.t.pnl) : rsOf(d.members);
    const b = d.useMoney ? d.normal.map((f) => f.t.pnl) : rsOf(d.normal);
    return {
      id, title: d.title,
      count: d.members.length,
      net: netOf(d.members),
      avgR: r4(mean(rsOf(d.members))),
      normalAvgR: r4(mean(rsOf(d.normal))),
      verdict: verdict({ a, b, candidates }),
      label: sampleLabel(d.members.length),
      tradeIds: idsOf(d.members),
      detail: d.detail,
    };
  });
}

/** The part of a gross loss below −1R: |gross| × (1 − 1 ÷ |R|); 0 within the stop. */
export function beyondStopAmount(f: TradeFacts): number {
  if (f.r == null || !(f.r < BEYOND_STOP_R) || f.gross >= 0) return 0;
  return Math.abs(f.gross) * (1 - 1 / Math.abs(f.r));
}
