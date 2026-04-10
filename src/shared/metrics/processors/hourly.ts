import { MetricProcessor, AggregationProcessor, TradeRecord, AggregationContext } from '../types';
import { calcPnL } from '../../utils/pnl';

type HourlyEntry = { count: number; wins: number; pnl: number };

/**
 * Hourly breakdown: win rate, trades, pnl per hour (0-23)
 * Aggregation strategy: MERGE MAPS (sum counts/wins/pnl per hour)
 */
export class HourlyProcessor implements MetricProcessor {
  readonly name = 'hourly';
  private hourlyMap: Record<string, HourlyEntry> = {};

  processTrade(trade: TradeRecord): void {
    const openDate = trade.openDate || '';
    // Only process if the date has a time component
    if (!openDate.includes('T')) return;

    const hour = new Date(openDate).getUTCHours().toString();
    if (!this.hourlyMap[hour]) this.hourlyMap[hour] = { count: 0, wins: 0, pnl: 0 };
    this.hourlyMap[hour].count++;

    const pnl = calcPnL(trade) ?? 0;
    if (pnl > 0) this.hourlyMap[hour].wins++;
    this.hourlyMap[hour].pnl += pnl;
  }

  getResult() {
    return {
      hourlyBreakdown: { ...this.hourlyMap },
    };
  }

  reset(): void {
    this.hourlyMap = {};
  }
}

export class HourlyAggregator implements AggregationProcessor {
  readonly name = 'hourly';
  private mergedMap: Record<string, HourlyEntry> = {};

  merge(record: Record<string, any>): void {
    const breakdown = record.hourlyBreakdown || {};
    for (const [hour, val] of Object.entries(breakdown) as [string, any][]) {
      if (!this.mergedMap[hour]) this.mergedMap[hour] = { count: 0, wins: 0, pnl: 0 };
      this.mergedMap[hour].count += val.count || 0;
      this.mergedMap[hour].wins += val.wins || 0;
      this.mergedMap[hour].pnl += val.pnl || 0;
    }
  }

  getResult(_context: AggregationContext) {
    // Return all 24 hours, with zeroes for hours with no trades
    const hourlyStats = Array.from({ length: 24 }, (_, i) => {
      const hour = i.toString();
      const data = this.mergedMap[hour] || { count: 0, wins: 0, pnl: 0 };
      return {
        hour: hour.padStart(2, '0'),
        trades: data.count,
        wins: data.wins,
        pnl: data.pnl,
        winRate: data.count > 0 ? (data.wins / data.count) * 100 : 0,
      };
    });

    return { hourlyStats };
  }

  reset(): void {
    this.mergedMap = {};
  }
}
