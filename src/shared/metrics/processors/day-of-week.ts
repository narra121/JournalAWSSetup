import { AggregationProcessor, AggregationContext } from '../types';

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/**
 * Daily win rate by day of week.
 * No daily processor needed — uses dayOfWeek + core stats from the daily record.
 * Aggregation strategy: ACCUMULATE by dayOfWeek index
 */
export class DayOfWeekAggregator implements AggregationProcessor {
  readonly name = 'dayOfWeek';
  private map: Record<number, { count: number; wins: number; pnl: number }> = {};

  merge(record: Record<string, any>): void {
    const dow = record.dayOfWeek as number;
    if (dow == null || dow < 0 || dow > 6) return;
    if (!this.map[dow]) this.map[dow] = { count: 0, wins: 0, pnl: 0 };
    this.map[dow].count += record.tradeCount || 0;
    this.map[dow].wins += record.wins || 0;
    this.map[dow].pnl += record.totalPnl || 0;
  }

  getResult(_context: AggregationContext) {
    const dailyWinRate = DAY_NAMES.map((day, index) => {
      const data = this.map[index] || { count: 0, wins: 0, pnl: 0 };
      return {
        day,
        trades: data.count,
        wins: data.wins,
        pnl: data.pnl,
        winRate: data.count > 0 ? (data.wins / data.count) * 100 : 0,
      };
    });
    return { dailyWinRate };
  }

  reset(): void {
    this.map = {};
  }
}
