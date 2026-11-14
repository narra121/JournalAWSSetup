import type { WhatIfRule } from '../analysis/types';

/**
 * A focus rule: one what-if rule (CONTRACT I4), or one of three behaviour rules that no what-if kind expresses because
 * they are kept or broken during a trade, not by skipping it:
 * - `exitAtStop`: a losing trade ends at its stop (broken = realised R below −1.05);
 * - `setStop`: every trade has a stop (broken = no stop recorded);
 * - `pauseAfterLoss`: no entry within `minutes` of a losing trade closing the same day.
 */
export type FocusRule = WhatIfRule | { kind: 'exitAtStop' } | { kind: 'setStop' } | { kind: 'pauseAfterLoss'; minutes: number };

export interface Focus {
  rule: FocusRule;
  /** the if-then sentence the trader committed to */
  text: string;
  /** ISO instant; only trades opened at or after it are checked */
  startedAt: string;
  /** the review finding it was adopted from (e.g. `detector:beyondStop`), when there was one */
  findingKey: string | null;
}

/** Kept/broken of a focus rule over the trades in scope. Money is in the currency of the trades checked. */
export interface FocusCheck {
  /** trades the rule applies to (for exitAtStop: losing trades with a stop) */
  checked: number;
  kept: number;
  broken: number;
  brokenTradeIds: string[];
  /** net P&L of the trades that broke it */
  brokenNet: number;
  /** money the breaks cost, never negative: the part beyond the stop for exitAtStop, else the breaks' net loss */
  cost: number;
}
