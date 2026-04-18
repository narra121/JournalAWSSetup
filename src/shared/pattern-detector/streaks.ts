import { PatternTrade, StreakInfo } from './types';

interface StreakAnalysis {
  streaks: StreakInfo[];
  longestWinStreak: StreakInfo | null;
  longestLossStreak: StreakInfo | null;
  currentStreak: StreakInfo | null;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export function analyzeStreaks(trades: PatternTrade[]): StreakAnalysis {
  if (trades.length === 0) {
    return {
      streaks: [],
      longestWinStreak: null,
      longestLossStreak: null,
      currentStreak: null,
    };
  }

  const sorted = [...trades].sort(
    (a, b) => new Date(a.openDate).getTime() - new Date(b.openDate).getTime()
  );

  const allStreaks: StreakInfo[] = [];
  let currentType: 'win' | 'loss' = sorted[0].pnl >= 0 ? 'win' : 'loss';
  let currentTradeIds: string[] = [sorted[0].tradeId];
  let currentTotalPnl = sorted[0].pnl;
  let currentStartDate = sorted[0].openDate;
  let currentEndDate = sorted[0].openDate;

  for (let i = 1; i < sorted.length; i++) {
    const trade = sorted[i];
    const tradeType: 'win' | 'loss' = trade.pnl >= 0 ? 'win' : 'loss';

    if (tradeType === currentType) {
      currentTradeIds.push(trade.tradeId);
      currentTotalPnl += trade.pnl;
      currentEndDate = trade.openDate;
    } else {
      // Emit the completed streak if length >= 2
      if (currentTradeIds.length >= 2) {
        allStreaks.push({
          type: currentType,
          length: currentTradeIds.length,
          totalPnl: round2(currentTotalPnl),
          startDate: currentStartDate,
          endDate: currentEndDate,
          tradeIds: [...currentTradeIds],
        });
      }

      // Start new streak
      currentType = tradeType;
      currentTradeIds = [trade.tradeId];
      currentTotalPnl = trade.pnl;
      currentStartDate = trade.openDate;
      currentEndDate = trade.openDate;
    }
  }

  // Emit final streak if length >= 2
  if (currentTradeIds.length >= 2) {
    allStreaks.push({
      type: currentType,
      length: currentTradeIds.length,
      totalPnl: round2(currentTotalPnl),
      startDate: currentStartDate,
      endDate: currentEndDate,
      tradeIds: [...currentTradeIds],
    });
  }

  // Find longest win and loss streaks
  let longestWinStreak: StreakInfo | null = null;
  let longestLossStreak: StreakInfo | null = null;

  for (const streak of allStreaks) {
    if (streak.type === 'win') {
      if (!longestWinStreak || streak.length > longestWinStreak.length) {
        longestWinStreak = streak;
      }
    } else {
      if (!longestLossStreak || streak.length > longestLossStreak.length) {
        longestLossStreak = streak;
      }
    }
  }

  // Current streak = the last consecutive run if length >= 2
  const lastStreak = allStreaks.length > 0 ? allStreaks[allStreaks.length - 1] : null;
  const currentStreak =
    lastStreak && lastStreak.endDate === sorted[sorted.length - 1].openDate
      ? lastStreak
      : null;

  return {
    streaks: allStreaks,
    longestWinStreak,
    longestLossStreak,
    currentStreak,
  };
}
