import { AggregationContext, AggregationProcessor, MetricProcessor, ProcessorContext, TradeRecord } from '../types';
import { calcPnL } from '../../utils/pnl';
import { hourOf, weekdayOf } from '../../timezone';
import { dict } from '../dict';

/** Per-key tallies; `rSum` / `rCount` cover the trades with a realised R (`realizedR`). */
interface Tally {
  trades: number;
  wins: number;
  net: number;
  rSum: number;
  rCount: number;
}

export const SEGMENT_DIMENSIONS = ['symbol', 'strategy', 'session', 'direction', 'assetClass', 'weekday', 'hour'] as const;
export type SegmentDimension = (typeof SEGMENT_DIMENSIONS)[number];
type TallyMap = Record<string, Tally>;
type Segments = Record<SegmentDimension | 'weekdayHour', TallyMap>;

export const R_BUCKETS = ['<=-2', '-2..-1', '-1..0', '0..1', '1..2', '2..3', '>3'] as const;

const emptyTally = (): Tally => ({ trades: 0, wins: 0, net: 0, rSum: 0, rCount: 0 });
const emptySegments = (): Segments => ({
  symbol: dict(), strategy: dict(), session: dict(), direction: dict(), assetClass: dict(), weekday: dict(), hour: dict(), weekdayHour: dict(),
});

const price = (v: unknown): number | null => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));

/** A stop of 0 is how the trade form stores "no stop"; a stop at the entry price risks nothing. */
export function hasStop(trade: TradeRecord): boolean {
  const entry = price(trade.entryPrice);
  const stop = price(trade.stopLoss);
  return entry !== null && stop !== null && stop > 0 && stop !== entry;
}

/**
 * Realised R from prices (CONTRACT I2): direction × (exit − entry) ÷ |entry − stop|, before fees. Quantity and the
 * contract multiplier cancel out, so trades imported without them still have an R. Null without a stop or an exit price.
 */
export function realizedR(trade: TradeRecord): number | null {
  const exit = price(trade.exitPrice);
  if (!hasStop(trade) || exit === null || (trade.side !== 'BUY' && trade.side !== 'SELL')) return null;
  const entry = Number(trade.entryPrice);
  const dir = trade.side === 'SELL' ? -1 : 1;
  return (dir * (exit - entry)) / Math.abs(entry - Number(trade.stopLoss));
}

/** Running sums of realised R; the aggregate's average and spread are derived from them, so days add up exactly. */
export interface RSums {
  rSum: number;
  rSumSq: number;
  rCount: number;
}

/** Average and sample standard deviation of R from sums; null below 1 (average) or 2 (spread) trades with an R. */
export function rSummary({ rSum, rSumSq, rCount }: RSums): { avgR: number | null; sdR: number | null; rCount: number } {
  if (rCount === 0) return { avgR: null, sdR: null, rCount: 0 };
  const avgR = rSum / rCount;
  const sdR = rCount < 2 ? null : Math.sqrt(Math.max(0, (rSumSq - rCount * avgR * avgR) / (rCount - 1)));
  return { avgR, sdR, rCount };
}

export function rBucket(r: number): (typeof R_BUCKETS)[number] {
  if (r <= -2) return '<=-2';
  if (r <= -1) return '-2..-1';
  if (r <= 0) return '-1..0';
  if (r <= 1) return '0..1';
  if (r <= 2) return '1..2';
  if (r <= 3) return '2..3';
  return '>3';
}

function add(map: TallyMap, key: string, pnl: number, r: number | null): void {
  const t = (map[key] ??= emptyTally());
  t.trades++;
  if (pnl > 0) t.wins++;
  t.net += pnl;
  if (r !== null) {
    t.rSum += r;
    t.rCount++;
  }
}

const emptySums = (): RSums => ({ rSum: 0, rSumSq: 0, rCount: 0 });

/**
 * Per-segment tallies for the Analytics explorer (BE-R4): symbol, strategy, session, direction, asset class, weekday,
 * hour and the weekday × hour grid, plus the realized-R histogram and the day's R sums (`rSum`, `rSumSq`, `rCount`).
 * Weekday and hour follow the trade's open time in the user's time zone (UTC when unset).
 */
export class SegmentsProcessor implements MetricProcessor {
  readonly name = 'segments';
  private seg: Segments = emptySegments();
  private rBuckets: Record<string, number> = dict();
  private noStop = 0;
  private sums: RSums = emptySums();

  processTrade(trade: TradeRecord, context?: ProcessorContext): void {
    const pnl = calcPnL(trade) ?? 0;
    const r = realizedR(trade);
    // The record's day is already the local day, so its weekday is the local weekday; the hour follows the user's zone.
    const day = context?.date || String(trade.openDate || '').split('T')[0];
    const validDay = /^\d{4}-\d{2}-\d{2}$/.test(day);
    const h = hourOf(trade.openDate || '', context?.timeZone);
    const weekday = validDay ? String(weekdayOf(day)) : null;
    const hour = validDay && h !== null ? String(h).padStart(2, '0') : null;

    add(this.seg.symbol, trade.symbol || 'Unknown', pnl, r);
    add(this.seg.strategy, trade.setupType || 'Unknown', pnl, r);
    add(this.seg.session, trade.tradingSession || 'Unknown', pnl, r);
    add(this.seg.direction, trade.side === 'SELL' ? 'SELL' : 'BUY', pnl, r);
    add(this.seg.assetClass, (trade.assetClass as string) || 'Unknown', pnl, r);
    // A date-only openDate has a weekday but no hour: it still counts for the weekday, like in dailyWinRate.
    if (weekday !== null) add(this.seg.weekday, weekday, pnl, r);
    if (weekday !== null && hour !== null) {
      add(this.seg.hour, hour, pnl, r);
      add(this.seg.weekdayHour, `${weekday}-${hour}`, pnl, r);
    }
    if (!hasStop(trade)) this.noStop++;
    if (r !== null) {
      this.rBuckets[rBucket(r)] = (this.rBuckets[rBucket(r)] || 0) + 1;
      this.sums.rSum += r;
      this.sums.rSumSq += r * r;
      this.sums.rCount++;
    }
  }

  getResult() {
    return { segments: { ...this.seg }, rDistribution: { buckets: { ...this.rBuckets }, noStop: this.noStop }, ...this.sums };
  }

  reset(): void {
    this.seg = emptySegments();
    this.rBuckets = dict();
    this.noStop = 0;
    this.sums = emptySums();
  }
}

export class SegmentsAggregator implements AggregationProcessor {
  readonly name = 'segments';
  private seg: Segments = emptySegments();
  private rBuckets: Record<string, number> = dict();
  private noStop = 0;
  private sums: RSums = emptySums();

  merge(record: Record<string, any>): void {
    this.sums.rSum += Number(record.rSum) || 0;
    this.sums.rSumSq += Number(record.rSumSq) || 0;
    this.sums.rCount += Number(record.rCount) || 0;
    const incoming: Segments | undefined = record.segments;
    if (incoming) {
      for (const dim of Object.keys(this.seg) as (keyof Segments)[]) {
        for (const [key, t] of Object.entries(incoming[dim] ?? {})) {
          const target = (this.seg[dim][key] ??= emptyTally());
          target.trades += t.trades || 0;
          target.wins += t.wins || 0;
          target.net += t.net || 0;
          target.rSum += t.rSum || 0;
          target.rCount += t.rCount || 0;
        }
      }
    }
    const r = record.rDistribution;
    if (r) {
      for (const [bucket, n] of Object.entries(r.buckets ?? {})) this.rBuckets[bucket] = (this.rBuckets[bucket] || 0) + (n as number);
      this.noStop += r.noStop || 0;
    }
  }

  getResult(_context: AggregationContext) {
    const out = (map: TallyMap) =>
      Object.fromEntries(
        Object.entries(map).map(([key, t]) => [key, { trades: t.trades, wins: t.wins, net: t.net, avgR: t.rCount > 0 ? t.rSum / t.rCount : null }]),
      );
    const segments: Record<string, any> = {};
    for (const dim of SEGMENT_DIMENSIONS) segments[dim] = out(this.seg[dim]);
    const weekdayHour = Object.entries(this.seg.weekdayHour).map(([key, t]) => {
      const [day, hour] = key.split('-');
      return { day: Number(day), hour: Number(hour), trades: t.trades, wins: t.wins, net: t.net };
    });
    return {
      ...rSummary(this.sums),
      segments,
      weekdayHour,
      rDistribution: {
        buckets: R_BUCKETS.map((label) => ({ label, count: this.rBuckets[label] || 0 })),
        noStop: this.noStop,
      },
    };
  }

  reset(): void {
    this.seg = emptySegments();
    this.rBuckets = dict();
    this.noStop = 0;
    this.sums = emptySums();
  }
}
