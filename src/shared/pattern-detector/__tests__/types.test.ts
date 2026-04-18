import { describe, it, expect } from 'vitest';
import type { PatternDetectionResult } from '../types.js';

describe('PatternDetectionResult (smoke test)', () => {
  it('creates a valid PatternDetectionResult object', () => {
    const result: PatternDetectionResult = {
      revengeTrades: [
        {
          tradeId: 't2',
          triggerTradeId: 't1',
          gapMinutes: 5,
          triggerPnl: -100,
          revengePnl: -50,
        },
      ],
      overtradeDays: [
        {
          date: '2026-04-10',
          tradeCount: 12,
          pnl: -200,
          avgTradesPerDay: 4,
        },
      ],
      streaks: [
        {
          type: 'win',
          length: 3,
          totalPnl: 300,
          startDate: '2026-04-01',
          endDate: '2026-04-03',
          tradeIds: ['t1', 't2', 't3'],
        },
        {
          type: 'loss',
          length: 2,
          totalPnl: -150,
          startDate: '2026-04-04',
          endDate: '2026-04-05',
          tradeIds: ['t4', 't5'],
        },
      ],
      longestWinStreak: {
        type: 'win',
        length: 3,
        totalPnl: 300,
        startDate: '2026-04-01',
        endDate: '2026-04-03',
        tradeIds: ['t1', 't2', 't3'],
      },
      longestLossStreak: {
        type: 'loss',
        length: 2,
        totalPnl: -150,
        startDate: '2026-04-04',
        endDate: '2026-04-05',
        tradeIds: ['t4', 't5'],
      },
      currentStreak: null,
      hourlyEdges: [
        {
          hour: 9,
          tradeCount: 20,
          winRate: 0.7,
          avgPnl: 50,
          totalPnl: 1000,
          label: 'green_zone',
        },
        {
          hour: 15,
          tradeCount: 10,
          winRate: 0.3,
          avgPnl: -20,
          totalPnl: -200,
          label: 'red_zone',
        },
      ],
      dayOfWeekEdges: [
        {
          day: 1,
          dayName: 'Monday',
          tradeCount: 15,
          winRate: 0.6,
          avgPnl: 30,
          totalPnl: 450,
          label: 'green_zone',
        },
        {
          day: 5,
          dayName: 'Friday',
          tradeCount: 8,
          winRate: 0.4,
          avgPnl: -10,
          totalPnl: -80,
          label: 'neutral',
        },
      ],
      costOfEmotion: {
        revengeTrading: {
          count: 1,
          totalPnl: -50,
          avgPnl: -50,
        },
        overtrading: {
          daysCount: 1,
          excessTradePnl: -200,
        },
        rulesViolations: {
          count: 3,
          totalPnl: -120,
        },
        totalEmotionalCost: -370,
      },
      tradeCount: 50,
      dateRange: {
        start: '2026-04-01',
        end: '2026-04-18',
      },
    };

    expect(result).toBeDefined();
    expect(result.revengeTrades).toHaveLength(1);
    expect(result.overtradeDays).toHaveLength(1);
    expect(result.streaks).toHaveLength(2);
    expect(result.longestWinStreak?.type).toBe('win');
    expect(result.longestLossStreak?.type).toBe('loss');
    expect(result.currentStreak).toBeNull();
    expect(result.hourlyEdges).toHaveLength(2);
    expect(result.dayOfWeekEdges).toHaveLength(2);
    expect(result.costOfEmotion.totalEmotionalCost).toBe(-370);
    expect(result.tradeCount).toBe(50);
    expect(result.dateRange.start).toBe('2026-04-01');
    expect(result.dateRange.end).toBe('2026-04-18');
  });
});
