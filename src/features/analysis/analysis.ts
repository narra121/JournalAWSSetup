import type { TradeRow } from '../trades-repo';
import { bootstrapMean, mean, MIN_RANGE_TRADES, sampleLabel, variance, wilson } from './evidence';
import { beyondStopAmount, computeDetectors, TARGET_REACHED_SHARE } from './detectors';
import { BEYOND_STOP_R, median, tradeFacts, type TradeFacts } from './facts';
import { nextTradesScenario } from './scenario';
import { idsOf, netOf, r4, round2, roundRange, rsOf, segmentTables } from './segments';
import type { Analysis, Concentration, EdgeSummary, ResultBridge, RiskExtras, RollingPoint } from './types';

export const ROLLING_WINDOW = 20;
export const CONCENTRATION_TOP = 3;
export const RISK_OUTLIER_MULTIPLE = 1.5;
const Z95 = 1.959963984540054;

export interface AnalysisOptions {
  period: { from: string; to: string };
  /** IANA zone that days, hours and weekdays follow */
  timeZone: string;
  currency?: string | null;
  truncated?: boolean;
  /** of the account(s) analysed; null = unknown (no shares of balance, no ±10% scenario) */
  startingBalance?: number | null;
  /** positive amount; null = no limit set */
  dailyLossLimit?: number | null;
  ruleTexts?: Map<string, string>;
}

const minutes1 = (v: number | null) => (v == null ? null : Math.round(v * 10) / 10);
const DAY_MS = 86_400_000;
const daysBetween = (a: string, b: string) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / DAY_MS);

/** Everything the Analytics page shows for one currency and period (research report §4). Pure and deterministic. */
export function buildAnalysis(trades: TradeRow[], opts: AnalysisOptions): Analysis {
  const facts = tradeFacts(trades, opts.timeZone);
  const { segments, tradesPerDay } = segmentTables(facts);
  const byClose = [...facts].sort((a, b) => (a.closeMs ?? a.openMs) - (b.closeMs ?? b.openMs) || a.index - b.index);
  const risk = riskExtras(facts, byClose, opts.startingBalance ?? null);
  return {
    period: { from: opts.period.from, to: opts.period.to, timeZone: opts.timeZone },
    currency: opts.currency ?? null,
    tradeCount: facts.length,
    truncated: !!opts.truncated,
    label: sampleLabel(facts.length),
    edge: edgeSummary(facts),
    bridge: resultBridge(facts),
    concentration: concentration(facts),
    rolling: rollingExpectancy(byClose),
    risk,
    timing: {
      byTradeNumber: segments.tradeNumber,
      holding: {
        winnersMedianMin: minutes1(median(facts.filter((f) => f.t.pnl > 0 && f.holdingMin != null).map((f) => f.holdingMin!))),
        losersMedianMin: minutes1(median(facts.filter((f) => f.t.pnl < 0 && f.holdingMin != null).map((f) => f.holdingMin!))),
      },
      tradesPerDay,
    },
    segments,
    detectors: computeDetectors(facts, { dailyLossLimit: opts.dailyLossLimit, ruleTexts: opts.ruleTexts, currency: opts.currency }),
    scenario: nextTradesScenario(facts.map((f) => f.t.pnl), { startingBalance: opts.startingBalance, deepestSoFar: risk.drawdown.deepest }),
  };
}

export function edgeSummary(facts: TradeFacts[]): EdgeSummary {
  const n = facts.length;
  const wins = facts.filter((f) => f.t.pnl > 0);
  const losses = facts.filter((f) => f.t.pnl < 0);
  const avgWin = mean(wins.map((f) => f.t.pnl));
  const avgLoss = mean(losses.map((f) => -f.t.pnl));
  const payoff = avgWin != null && avgLoss ? avgWin / avgLoss : null;
  // Break-even trades count in the win rate's denominator, so the break-even rate is scaled by the decisive share.
  const decisive = n ? (wins.length + losses.length) / n : 0;
  const breakEven = !wins.length ? null : !losses.length ? 0 : decisive / (1 + payoff!);
  const rs = rsOf(facts);
  const m = mean(rs);
  const range = bootstrapMean(rs);
  let needed: number | null = null;
  if (m != null && m !== 0 && rs.length >= 2 && !(range && (range.lo > 0 || range.hi < 0))) {
    const sd = Math.sqrt(variance(rs));
    needed = Math.max(Math.ceil(((Z95 * sd) / m) ** 2), MIN_RANGE_TRADES, rs.length + 1);
  }
  return {
    winRate: n ? wins.length / n : 0,
    winRateRange: n >= MIN_RANGE_TRADES ? wilson(wins.length, n) : null,
    payoff: r4(payoff),
    breakEvenWinRate: r4(breakEven),
    expectancyMoney: n ? round2(netOf(facts) / n) : null,
    expectancyR: r4(m),
    expectancyRRange: roundRange(range),
    tradesWithR: rs.length,
    tradesNeeded: needed,
  };
}

/** Gross profit → losses within the planned risk → beyond the stop → without a stop → fees → net; the parts are before fees. */
export function resultBridge(facts: TradeFacts[]): ResultBridge {
  let grossProfit = 0, within = 0, beyond = 0, noStop = 0, fees = 0, beyondTrades = 0;
  for (const f of facts) {
    fees += f.t.fees;
    if (f.gross >= 0) {
      grossProfit += f.gross;
      continue;
    }
    if (f.r == null) {
      noStop += f.gross;
      continue;
    }
    const past = beyondStopAmount(f);
    beyond -= past;
    within += f.gross + past;
    if (past > 0) beyondTrades++;
  }
  return {
    grossProfit: round2(grossProfit),
    lossesWithinPlan: round2(within),
    lossesBeyondStop: round2(beyond),
    lossesWithoutStop: round2(noStop),
    fees: round2(-fees),
    net: netOf(facts),
    losingTrades: facts.filter((f) => f.t.pnl < 0).length,
    beyondStopTrades: beyondTrades,
  };
}

export function concentration(facts: TradeFacts[]): Concentration {
  const net = netOf(facts);
  const wins = facts.filter((f) => f.t.pnl > 0).sort((a, b) => b.t.pnl - a.t.pnl || a.index - b.index);
  const losses = facts.filter((f) => f.t.pnl < 0).sort((a, b) => a.t.pnl - b.t.pnl || a.index - b.index);
  const best = wins.slice(0, CONCENTRATION_TOP);
  const worst = losses.slice(0, CONCENTRATION_TOP);
  const sum = (fs: TradeFacts[]) => fs.reduce((s, f) => s + f.t.pnl, 0);
  return {
    top: CONCENTRATION_TOP,
    bestShareOfProfit: wins.length ? r4(sum(best) / sum(wins)) : null,
    netWithoutBest: round2(net - sum(best)),
    worstShareOfLosses: losses.length ? r4(sum(worst) / sum(losses)) : null,
    netWithoutWorst: round2(net - sum(worst)),
    bestTradeIds: idsOf(best),
    worstTradeIds: idsOf(worst),
  };
}

/** Average R of the last 20 trades with an R, in close order; nothing until 20 such trades exist. */
export function rollingExpectancy(byClose: TradeFacts[]): RollingPoint[] {
  const out: RollingPoint[] = [];
  const window: number[] = [];
  let sum = 0;
  for (const f of byClose) {
    if (f.r == null) continue;
    window.push(f.r);
    sum += f.r;
    if (window.length > ROLLING_WINDOW) sum -= window.shift()!;
    if (window.length < ROLLING_WINDOW) continue;
    const point = { date: f.closeDay, avgR: r4(sum / ROLLING_WINDOW)! };
    if (out.length && out[out.length - 1].date === f.closeDay) out[out.length - 1] = point;
    else out.push(point);
  }
  return out;
}

export function riskExtras(facts: TradeFacts[], byClose: TradeFacts[], startingBalance: number | null): RiskExtras {
  const rs = rsOf(facts);
  const beyond = facts.filter((f) => f.r != null && f.r < BEYOND_STOP_R);

  const winners = facts.filter((f) => f.t.pnl > 0 && f.r != null && f.plannedRR != null);
  const planned = mean(winners.map((f) => f.plannedRR!));
  const captured = mean(winners.map((f) => f.r!));

  const risky = facts.filter((f) => f.risk != null && f.risk > 0);
  const medRisk = median(risky.map((f) => f.risk!));
  const largest = risky.reduce((m, f) => Math.max(m, f.risk!), 0);
  const outliers = medRisk == null ? [] : risky.filter((f) => f.risk! > RISK_OUTLIER_MULTIPLE * medRisk);
  const balance = startingBalance != null && startingBalance > 0 ? startingBalance : null;

  return {
    avgR: r4(mean(rs)),
    rSpread: rs.length >= 2 ? r4(Math.sqrt(variance(rs))) : null,
    beyondStop: { count: beyond.length, losingTrades: facts.filter((f) => f.t.pnl < 0).length, amount: round2(beyond.reduce((s, f) => s + beyondStopAmount(f), 0)), tradeIds: idsOf(beyond) },
    plannedVsCaptured: winners.length
      ? { winners: winners.length, plannedAvgR: r4(planned)!, capturedAvgR: r4(captured)!, captureRatio: r4(captured! / planned!)!, reachedTarget: winners.filter((f) => f.r! >= TARGET_REACHED_SHARE * f.plannedRR!).length, tradeIds: idsOf(winners) }
      : null,
    riskPerTrade: medRisk == null
      ? null
      : {
          trades: risky.length,
          median: round2(medRisk),
          largest: round2(largest),
          medianShareOfBalance: balance ? r4(medRisk / balance) : null,
          largestShareOfBalance: balance ? r4(largest / balance) : null,
          aboveMultiple: { multiple: RISK_OUTLIER_MULTIPLE, count: outliers.length, net: netOf(outliers), tradeIds: idsOf(outliers) },
        },
    drawdown: drawdownFacts(byClose),
  };
}

/** Drawdown of the daily close series from the start of the period (the starting equity is the first high). */
export function drawdownFacts(byClose: TradeFacts[]): RiskExtras['drawdown'] {
  const daily = new Map<string, number>();
  for (const f of byClose) daily.set(f.closeDay, (daily.get(f.closeDay) ?? 0) + f.t.pnl);
  const days = [...daily.keys()].sort();
  let equity = 0, peak = 0, deepest = 0, longest = 0;
  let since: string | null = null;
  for (const d of days) {
    equity += daily.get(d)!;
    if (equity >= peak - 1e-9) {
      if (since) longest = Math.max(longest, daysBetween(since, d));
      peak = Math.max(peak, equity);
      since = null;
    } else {
      since ??= d;
      deepest = Math.max(deepest, peak - equity);
    }
  }
  if (since) longest = Math.max(longest, daysBetween(since, days[days.length - 1]) + 1);
  return { current: round2(days.length ? Math.max(0, peak - equity) : 0), deepest: round2(deepest), longestDays: longest, since };
}
