import { MetricProcessor, AggregationProcessor, TradeRecord, AggregationContext } from '../types';
import { calcPnL } from '../../utils/pnl';

/**
 * PnL Sequence: pnlSequence (ordered PnLs), equityCurvePoints
 * → Aggregated into: consecutiveWins/Losses, maxDrawdown, sharpeRatio, equityCurve, dailyPnl
 * Aggregation strategy: CONCATENATE in date order, then COMPUTE
 */
export class PnlSequenceProcessor implements MetricProcessor {
  readonly name = 'pnlSequence';
  private pnlSeq: number[] = [];
  private equityPoints: Array<{ pnl: number; symbol: string; dateTime: string }> = [];

  processTrade(trade: TradeRecord): void {
    const pnl = calcPnL(trade) ?? 0;
    this.pnlSeq.push(pnl);
    this.equityPoints.push({
      pnl,
      symbol: trade.symbol || '',
      dateTime: trade.closeDate || trade.openDate || '',
    });
  }

  getResult() {
    return {
      pnlSequence: [...this.pnlSeq],
      equityCurvePoints: [...this.equityPoints],
    };
  }

  reset(): void {
    this.pnlSeq = [];
    this.equityPoints = [];
  }
}

// --- Aggregation helpers ---

function computeStreaks(pnlValues: number[]): { consecutiveWins: number; consecutiveLosses: number } {
  let maxWins = 0, maxLosses = 0, curWins = 0, curLosses = 0;
  for (const pnl of pnlValues) {
    if (pnl > 0) {
      curWins++;
      curLosses = 0;
      if (curWins > maxWins) maxWins = curWins;
    } else if (pnl < 0) {
      curLosses++;
      curWins = 0;
      if (curLosses > maxLosses) maxLosses = curLosses;
    }
    // breakeven (pnl === 0) does not break streaks
  }
  return { consecutiveWins: maxWins, consecutiveLosses: maxLosses };
}

/**
 * Largest fall from a peak of the equity curve, as a percentage of the starting capital. Without a starting capital
 * there is nothing to measure a percentage against, so the result is null (never a made-up base).
 */
function computeMaxDrawdown(pnlValues: number[], totalCapital?: number): number | null {
  if (!(totalCapital && totalCapital > 0)) return null;
  let maxDrawdown = 0;
  let peak = totalCapital;
  let equity = totalCapital;
  for (const pnl of pnlValues) {
    equity += pnl;
    if (equity > peak) peak = equity;
    const dd = ((peak - equity) / totalCapital) * 100;
    if (dd > maxDrawdown) maxDrawdown = dd;
  }
  return maxDrawdown;
}

function computeSharpeRatio(pnlValues: number[]): number {
  if (pnlValues.length <= 1) return 0;
  const total = pnlValues.reduce((s, v) => s + v, 0);
  const avg = total / pnlValues.length;
  const variance = pnlValues.reduce((s, v) => s + Math.pow(v - avg, 2), 0) / (pnlValues.length - 1);
  const stdDev = Math.sqrt(variance);
  return stdDev > 0 ? avg / stdDev : 0;
}

export class PnlSequenceAggregator implements AggregationProcessor {
  readonly name = 'pnlSequence';
  /** Per-trade P&Ls with the time of the matching equity point (null when the record carries none). */
  private seq: Array<{ pnl: number; at: number | null }> = [];
  private allEquityPoints: Array<{ pnl: number; symbol: string; dateTime: string }> = [];
  private dailyPnlMap: Map<string, number> = new Map();
  private recordDates: Set<string> = new Set();

  merge(record: Record<string, any>): void {
    const seq: number[] = record.pnlSequence || [];
    const points: Array<{ pnl: number; symbol: string; dateTime: string }> = record.equityCurvePoints || [];
    seq.forEach((pnl, i) => {
      const at = points.length === seq.length ? Date.parse(points[i].dateTime) : NaN;
      this.seq.push({ pnl, at: Number.isNaN(at) ? null : at });
    });
    this.allEquityPoints.push(...points);

    // Accumulate per-date totalPnl for dailyPnl array
    const date = record.date as string;
    if (date) {
      this.dailyPnlMap.set(date, (this.dailyPnlMap.get(date) || 0) + (record.totalPnl || 0));
      this.recordDates.add(date);
    }
  }

  getResult(context: AggregationContext) {
    // Records are merged day by day and account by account; with several accounts a day's trades interleave in time,
    // so streaks and drawdown need the trades in time order. Without a time on every trade the merge order stays.
    const ordered = this.seq.every((e) => e.at !== null) ? [...this.seq].sort((a, b) => a.at! - b.at!) : this.seq;
    const allPnls = ordered.map((e) => e.pnl);
    const { consecutiveWins, consecutiveLosses } = computeStreaks(allPnls);
    const maxDrawdown = computeMaxDrawdown(allPnls, context.totalCapital);
    const sharpeRatio = computeSharpeRatio(allPnls);

    // Build dailyPnl (always included)
    const sortedDates = [...this.recordDates].sort();
    let cumPnl = 0;
    const dailyPnl = sortedDates.map(date => {
      const pnl = this.dailyPnlMap.get(date) || 0;
      cumPnl += pnl;
      return { date, pnl, cumulativePnl: cumPnl };
    });

    const result: Record<string, any> = {
      consecutiveWins,
      consecutiveLosses,
      maxDrawdown,
      sharpeRatio,
      dailyPnl,
    };

    // Equity curve (optional, per-trade granularity)
    if (context.includeEquityCurve && this.allEquityPoints.length > 0) {
      const sorted = [...this.allEquityPoints].sort(
        (a, b) => new Date(a.dateTime).getTime() - new Date(b.dateTime).getTime()
      );
      let cum = 0;
      result.equityCurve = sorted.map(pt => {
        cum += pt.pnl;
        return { date: pt.dateTime, pnl: pt.pnl, cumulativePnl: cum, symbol: pt.symbol };
      });
    }

    return result;
  }

  reset(): void {
    this.seq = [];
    this.allEquityPoints = [];
    this.dailyPnlMap = new Map();
    this.recordDates = new Set();
  }
}
