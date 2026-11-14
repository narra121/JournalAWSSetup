import { mean } from './evidence';
import { groupByDay, knownBefore, median, type TradeFacts } from './facts';
import { dimensionValues, idsOf, matchesValue, netOf, r4, rsOf } from './segments';
import { DIMENSIONS, type Dimension, type WhatIfResult, type WhatIfRule } from './types';

/** The trades a rule would have blocked. Only trades that happened are removed, so the replay predicts nothing. */
export function blockedBy(facts: TradeFacts[], rule: WhatIfRule): Set<TradeFacts> {
  const blocked = new Set<TradeFacts>();
  switch (rule.kind) {
    case 'stopAfterLosses':
      // Losses count once they have closed, and only among trades the rule still let through.
      for (const list of groupByDay(facts).values()) {
        const taken: TradeFacts[] = [];
        for (const f of list) {
          if (knownBefore(f, taken).filter((g) => g.t.pnl < 0).length >= rule.n) blocked.add(f);
          else taken.push(f);
        }
      }
      break;
    case 'maxTradesPerDay':
      for (const f of facts) if (f.tradeNumber > rule.n) blocked.add(f);
      break;
    case 'noTradesAfter': {
      const [h, m] = rule.time.split(':').map(Number);
      for (const f of facts) if (f.minuteOfDay != null && f.minuteOfDay >= h * 60 + m) blocked.add(f);
      break;
    }
    case 'skipSegment':
      for (const f of facts) if (dimensionValues(f, rule.dimension).some((v) => matchesValue(v, rule.key))) blocked.add(f);
      break;
    case 'maxRiskMultiple': {
      const med = median(facts.map((f) => f.risk).filter((x): x is number => x != null && x > 0));
      if (med != null) for (const f of facts) if (f.risk != null && f.risk > rule.multiple * med) blocked.add(f);
      break;
    }
  }
  return blocked;
}

export function replay(facts: TradeFacts[], rule: WhatIfRule): WhatIfResult {
  const blocked = blockedBy(facts, rule);
  const kept = facts.filter((f) => !blocked.has(f));
  const removed = facts.filter((f) => blocked.has(f));
  return {
    actualNet: netOf(facts),
    replayNet: netOf(kept),
    removed: removed.length,
    removedTradeIds: idsOf(removed),
    actualAvgR: r4(mean(rsOf(facts))),
    replayAvgR: r4(mean(rsOf(kept))),
  };
}

const isInt = (v: unknown, min: number, max: number): v is number => typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max;

/** A rule from untrusted JSON (API body, model tool call); a message when it is not one. */
export function parseWhatIfRule(x: unknown): WhatIfRule | string {
  const o = x as Record<string, unknown> | null;
  if (!o || typeof o !== 'object') return 'rule must be an object.';
  switch (o.kind) {
    case 'stopAfterLosses':
    case 'maxTradesPerDay':
      return isInt(o.n, 1, 100) ? { kind: o.kind, n: o.n } : 'n must be a whole number from 1 to 100.';
    case 'noTradesAfter':
      return typeof o.time === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(o.time) ? { kind: 'noTradesAfter', time: o.time } : 'time must look like 20:00.';
    case 'skipSegment':
      if (!DIMENSIONS.includes(o.dimension as never)) return `dimension must be one of ${DIMENSIONS.join(', ')}.`;
      return typeof o.key === 'string' && o.key.trim() && o.key.length <= 100 ? { kind: 'skipSegment', dimension: o.dimension as Dimension, key: o.key } : 'key must be a segment key.';
    case 'maxRiskMultiple':
      return typeof o.multiple === 'number' && Number.isFinite(o.multiple) && o.multiple >= 1 && o.multiple <= 100 ? { kind: 'maxRiskMultiple', multiple: o.multiple } : 'multiple must be a number from 1 to 100.';
    default:
      return 'kind must be stopAfterLosses, maxTradesPerDay, noTradesAfter, skipSegment or maxRiskMultiple.';
  }
}
