import { PatternTrade, HourlyEdge, DayOfWeekEdge } from './types';

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function computeLabel(
  winRate: number,
  avgPnl: number,
  count: number
): 'green_zone' | 'red_zone' | 'neutral' {
  if (count < 3) return 'neutral';
  if (winRate >= 60 && avgPnl > 0) return 'green_zone';
  if (winRate <= 40 || avgPnl < 0) return 'red_zone';
  return 'neutral';
}

interface Bucket {
  count: number;
  wins: number;
  totalPnl: number;
}

export function analyzeHourlyEdges(trades: PatternTrade[]): HourlyEdge[] {
  const buckets = new Map<number, Bucket>();

  for (const trade of trades) {
    const hour = new Date(trade.openDate).getUTCHours();
    const existing = buckets.get(hour) || { count: 0, wins: 0, totalPnl: 0 };
    existing.count++;
    if (trade.pnl > 0) existing.wins++;
    existing.totalPnl += trade.pnl;
    buckets.set(hour, existing);
  }

  const result: HourlyEdge[] = [];

  for (const [hour, bucket] of buckets) {
    if (bucket.count === 0) continue;
    const winRate = round2((bucket.wins / bucket.count) * 100);
    const avgPnl = round2(bucket.totalPnl / bucket.count);
    const totalPnl = round2(bucket.totalPnl);
    const label = computeLabel(winRate, avgPnl, bucket.count);

    result.push({
      hour,
      tradeCount: bucket.count,
      winRate,
      avgPnl,
      totalPnl,
      label,
    });
  }

  return result.sort((a, b) => a.hour - b.hour);
}

export function analyzeDayOfWeekEdges(trades: PatternTrade[]): DayOfWeekEdge[] {
  const buckets: Bucket[] = Array.from({ length: 7 }, () => ({
    count: 0,
    wins: 0,
    totalPnl: 0,
  }));

  for (const trade of trades) {
    const day = new Date(trade.openDate).getUTCDay();
    buckets[day].count++;
    if (trade.pnl > 0) buckets[day].wins++;
    buckets[day].totalPnl += trade.pnl;
  }

  return buckets.map((bucket, day) => {
    const winRate = bucket.count > 0 ? round2((bucket.wins / bucket.count) * 100) : 0;
    const avgPnl = bucket.count > 0 ? round2(bucket.totalPnl / bucket.count) : 0;
    const totalPnl = round2(bucket.totalPnl);
    const label = computeLabel(winRate, avgPnl, bucket.count);

    return {
      day,
      dayName: DAY_NAMES[day],
      tradeCount: bucket.count,
      winRate,
      avgPnl,
      totalPnl,
      label,
    };
  });
}
