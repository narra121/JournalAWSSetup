import { MetricProcessor, AggregationProcessor, TradeRecord, AggregationContext } from '../types';
import { calcPnL } from '../../utils/pnl';
import { dict } from '../dict';
import { realizedR } from './segments';

/** `rSum` / `rCount` cover the trades with a realised R (a stop and an exit price). */
export type TagEntry = { count: number; totalPnl: number; rSum: number; rCount: number };
export type TagMap = Record<string, TagEntry>;
/** What `/stats` returns per tag: `avgR` is null when no trade of the tag has an R. */
export type TagResult = { count: number; totalPnl: number; rCount: number; avgR: number | null };

export const emptyTag = (): TagEntry => ({ count: 0, totalPnl: 0, rSum: 0, rCount: 0 });

export function addTrade(entry: TagEntry, pnl: number, r: number | null): void {
  entry.count++;
  entry.totalPnl += pnl;
  if (r !== null) {
    entry.rSum += r;
    entry.rCount++;
  }
}

/** Daily records written before R was tallied lack `rSum` / `rCount`; they count as trades without an R. */
export function mergeTag(target: TagEntry, source: Partial<TagEntry> | undefined): void {
  if (!source) return;
  target.count += source.count || 0;
  target.totalPnl += source.totalPnl || 0;
  target.rSum += source.rSum || 0;
  target.rCount += source.rCount || 0;
}

export const tagResult = (e: TagEntry): TagResult => ({ count: e.count, totalPnl: e.totalPnl, rCount: e.rCount, avgR: e.rCount > 0 ? e.rSum / e.rCount : null });

/** Valid tag strings of a trade field; an empty list means the trade carries none. */
export function tagsOf(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => !!v && typeof v === 'string') : [];
}

/**
 * Mistakes: per mistake tag the count, P&L and R sums of its trades, plus the same for trades with no mistake tag
 * (`noMistakeTrades`, the baseline the Behaviour tab compares against).
 * Aggregation strategy: MERGE MAPS (sum per key)
 */
export class MistakesProcessor implements MetricProcessor {
  readonly name = 'mistakes';
  private distribution: TagMap = dict();
  private untagged: TagEntry = emptyTag();

  processTrade(trade: TradeRecord): void {
    const mistakes = tagsOf(trade.mistakes);
    const pnl = calcPnL(trade) ?? 0;
    const r = realizedR(trade);
    if (mistakes.length === 0) {
      addTrade(this.untagged, pnl, r);
      return;
    }
    for (const mistake of mistakes) addTrade((this.distribution[mistake] ??= emptyTag()), pnl, r);
  }

  getResult() {
    return { mistakesDistribution: { ...this.distribution }, noMistakeTrades: { ...this.untagged } };
  }

  reset(): void {
    this.distribution = dict();
    this.untagged = emptyTag();
  }
}

export class MistakesAggregator implements AggregationProcessor {
  readonly name = 'mistakes';
  private distribution: TagMap = dict();
  private untagged: TagEntry = emptyTag();

  merge(record: Record<string, any>): void {
    for (const [key, val] of Object.entries((record.mistakesDistribution || {}) as TagMap)) mergeTag((this.distribution[key] ??= emptyTag()), val);
    mergeTag(this.untagged, record.noMistakeTrades);
  }

  getResult(_context: AggregationContext) {
    const out: Record<string, TagResult> = dict();
    for (const [key, e] of Object.entries(this.distribution)) out[key] = tagResult(e);
    return { mistakesDistribution: out, noMistakeTrades: tagResult(this.untagged) };
  }

  reset(): void {
    this.distribution = dict();
    this.untagged = emptyTag();
  }
}
