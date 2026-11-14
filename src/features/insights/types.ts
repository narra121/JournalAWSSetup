// Weekly review types (CONTRACT I6, research report §5.2). The frontend copies this file to TradeFlow src/types/insights.ts.
// Money is in `Review.currency`, rounded to cents; R is realised R (CONTRACT I2); shares are fractions (0.25 = 25%).
// Every number is computed in code; the model writes only the `text` fields, which are checked to hold no other number.
import type { SampleLabel, Verdict } from '../analysis/types';
import type { FocusCheck, FocusRule } from '../focus/types';

export type { FocusRule } from '../focus/types';

/** `detector:<DetectorId>`, `segment:<Dimension>:<key>`, `rule:<rule text, lower case>`, `mistake:<tag, lower case>`, `different:<measure>` */
export type FindingKey = string;
export type FindingSource = 'detector' | 'segment' | 'rule' | 'mistake';

export interface FindingHistory {
  /** consecutive ISO weeks, this one included, in which the finding had trades */
  weeksInRow: number;
  /** trades of the finding in the previous ISO week; null when that week has no record of it */
  lastWeekCount: number | null;
  /** new = not in last week's record; down/up/same = this week's trades against last week's */
  status: 'new' | 'down' | 'up' | 'same';
}

export interface ReviewFinding {
  key: FindingKey;
  source: FindingSource;
  title: string;
  /** trades of this period attributed to the finding; a trade is attributed to one finding at most */
  trades: number;
  /** at most 100 */
  tradeIds: string[];
  /** money the behaviour cost this period (positive): the part beyond the stop for beyondStop, else the net loss of its trades */
  cost: number;
  /** R the behaviour cost (positive); null when none of its trades has a stop */
  costR: number | null;
  net: number;
  avgR: number | null;
  /** trades with the behaviour in the baseline and the period together, with its sample label and evidence verdict */
  evidenceTrades: number;
  label: SampleLabel;
  verdict: Verdict;
  /** accounting: a process break, counted and summed (no threshold needed); evidence: a pattern that passed the evidence rule as a leak */
  basis: 'accounting' | 'evidence';
  /** the if-then rule to adopt */
  ruleText: string;
  /** null when the rule cannot be checked from trade data (a rule or mistake tag of the trader's own) */
  rule: FocusRule | null;
  /** this period replayed under the rule (null when it cannot be replayed): removed = trades it would have blocked */
  replay: { actualNet: number; replayNet: number; removed: number } | null;
  /** other findings and patterns largely made of the same trades: merged here so their money is counted once */
  overlaps: { key: FindingKey; title: string; shared: number }[];
  history: FindingHistory;
  text: string;
}

export interface ReviewVerdict {
  /** from net R when at least half of the trades have one, else from net P&L */
  result: 'winning' | 'losing' | 'flat';
  /** clean: 80%+ of trades free of process breaks; mixed: 50-79%; poor: under 50% */
  process: 'clean' | 'mixed' | 'poor';
  net: number;
  /** sum of realised R; null when no trade has a stop */
  netR: number | null;
  tradesWithR: number;
  /** share of trades with no process break (beyond the stop, no stop, re-entry, size-up, overtrading day, broken rule, mistake tag) */
  cleanShare: number;
  stopShare: number;
  /** losing trades with a stop that ended within it; null without such losers */
  keptToStopShare: number | null;
  /** trades inside the daily trade cap of a maxTradesPerDay focus; null without one */
  insideCapShare: number | null;
  /** losing period only: share of the loss that process findings account for (0-1); null otherwise */
  selfInflictedShare: number | null;
  /** fixed wording chosen by code, e.g. "A losing week, mostly self-inflicted." */
  headline: string;
  text: string;
}

export interface LastFocus extends FocusCheck {
  rule: FocusRule;
  ruleText: string;
  startedAt: string;
  text: string;
}

export interface KeepDoing {
  key: FindingKey;
  title: string;
  /** over the baseline and the period */
  trades: number;
  periodTrades: number;
  winRate: number;
  avgR: number | null;
  avgRRange: { lo: number; hi: number } | null;
  label: SampleLabel;
  text: string;
}

export type DifferentMeasure = 'tradesPerDay' | 'riskPerTrade' | 'avgR' | 'winRate';
export interface DifferentItem {
  key: FindingKey;
  measure: DifferentMeasure;
  /** tradesPerDay: trades a trading day; riskPerTrade: median money at the stop; avgR: R; winRate: share */
  value: number;
  /** lowest and highest weekly value of the last 12 weeks (weeks with trades only) */
  normalLo: number;
  normalHi: number;
  weeks: number;
  direction: 'above' | 'below';
  text: string;
}

export interface NoteTheme {
  /** the model's wording; quotes are the trader's own words, checked against the notes */
  theme: string;
  side: 'winning' | 'losing' | 'both';
  quotes: { tradeId: string; quote: string }[];
}

export interface WatchItem {
  key: FindingKey;
  source: FindingSource;
  title: string;
  /** this period */
  trades: number;
  wins: number;
  net: number;
  avgR: number | null;
  tradeIds: string[];
  evidenceTrades: number;
  label: SampleLabel;
  /** net positive although the trader tagged it a mistake or a broken rule: it paid, which is not evidence that it works */
  paidSoFar: boolean;
  overlaps: { key: FindingKey; title: string; shared: number }[];
  text: string;
}

export interface Review {
  version: 1;
  currency: string | null;
  timeZone: string;
  /** the 90 days before the period: verdicts, the trader's usual risk and day are judged over baseline + period */
  baseline: { from: string; to: string; trades: number };
  verdict: ReviewVerdict;
  /** the costliest behaviour; null when nothing cost money */
  theOne: ReviewFinding | null;
  /** at most two further costed findings, none sharing a trade with theOne or each other */
  more: ReviewFinding[];
  /** present when a focus was active during the period */
  lastFocus?: LastFocus;
  /** present only when a segment passes the evidence rule as an edge */
  keepDoing?: KeepDoing;
  different: DifferentItem[];
  /** present only when the trader has switched on sending notes to the model */
  fromNotes?: NoteTheme[];
  watch: WatchItem[];
  /** findings shown last week that have no trades this week */
  resolved: { key: FindingKey; title: string; lastWeekCount: number }[];
  /** keys the trader marked not useful in the last 30 days, left out of this review */
  muted: FindingKey[];
}
