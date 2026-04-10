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

function computeMaxDrawdown(pnlValues: number[], totalCapital?: number): number {
  if (pnlValues.length === 0) return 0;
  let maxDrawdown = 0;

  if (totalCapital && totalCapital > 0) {
    let peak = totalCapital;
    let equity = totalCapital;
    for (const pnl of pnlValues) {
      equity += pnl;
      if (equity > peak) peak = equity;
      const dd = peak > 0 ? ((peak - equity) / totalCapital) * 100 : 0;
      if (dd > maxDrawdown) maxDrawdown = dd;
    }
  } else {
    // Equity curve method (matches frontend lines 146-165)
    let runningPnl = 0;
    let minRunningPnl = 0;
    for (const pnl of pnlValues) {
      runningPnl += pnl;
      if (runningPnl < minRunningPnl) minRunningPnl = runningPnl;
    }
    const startingEquity = (minRunningPnl < 0 ? -minRunningPnl : 0) + 1;
    let peakEquity = startingEquity;
    let equity = startingEquity;
    for (const pnl of pnlValues) {
      equity += pnl;
      if (equity > peakEquity) peakEquity = equity;
      const dd = peakEquity > 0 ? ((peakEquity - equity) / peakEquity) * 100 : 0;
      if (dd > maxDrawdown) maxDrawdown = dd;
    }
  }
  return maxDrawdown;
}

function computeSharpeRatio(pnlValues: number[]): number {
  if (pnlValues.length === 0) return 0;
  const total = pnlValues.reduce((s, v) => s + v, 0);
  const avg = total / pnlValues.length;
  const variance = pnlValues.reduce((s, v) => s + Math.pow(v - avg, 2), 0) / pnlValues.length;
  const stdDev = Math.sqrt(variance);
  return stdDev > 0 ? avg / stdDev : 0;
}

export class PnlSequenceAggregator implements AggregationProcessor {
  readonly name = 'pnlSequence';
  private allPnls: number[] = [];
  private allEquityPoints: Array<{ pnl: number; symbol: string; dateTime: string }> = [];
  private dailyPnlMap: Map<string, number> = new Map();
  private recordDates: string[] = [];

  merge(record: Record<string, any>): void {
    const seq = record.pnlSequence || [];
    this.allPnls.push(...seq);
    this.allEquityPoints.push(...(record.equityCurvePoints || []));

    // Accumulate per-date totalPnl for dailyPnl array
    const date = record.date as string;
    if (date) {
      this.dailyPnlMap.set(date, (this.dailyPnlMap.get(date) || 0) + (record.totalPnl || 0));
      if (!this.recordDates.includes(date)) this.recordDates.push(date);
    }
  }

  getResult(context: AggregationContext) {
    const { consecutiveWins, consecutiveLosses } = computeStreaks(this.allPnls);
    const maxDrawdown = computeMaxDrawdown(this.allPnls, context.totalCapital);
    const sharpeRatio = computeSharpeRatio(this.allPnls);

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
    this.allPnls = [];
    this.allEquityPoints = [];
    this.dailyPnlMap = new Map();
    this.recordDates = [];
  }
}
