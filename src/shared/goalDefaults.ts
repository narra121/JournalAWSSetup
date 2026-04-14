export const VALID_GOAL_TYPES = ['profit', 'winRate', 'maxDrawdown', 'maxTrades'] as const;
export const VALID_PERIODS = ['weekly', 'monthly'] as const;

export type GoalType = typeof VALID_GOAL_TYPES[number];

export const GOAL_TYPE_CONFIG: Record<GoalType, {
  title: string;
  description: string;
  unit: string;
  icon: string;
  color: string;
  isInverse: boolean;
}> = {
  profit: {
    title: 'Profit Target',
    description: 'Reach your profit goal',
    unit: '$',
    icon: 'target',
    color: 'text-primary',
    isInverse: false,
  },
  winRate: {
    title: 'Win Rate',
    description: 'Maintain win rate goal',
    unit: '%',
    icon: 'trending-up',
    color: 'text-success',
    isInverse: false,
  },
  maxDrawdown: {
    title: 'Max Drawdown',
    description: 'Keep drawdown under limit',
    unit: '%',
    icon: 'shield',
    color: 'text-warning',
    isInverse: true,
  },
  maxTrades: {
    title: 'Max Trades',
    description: 'Stay under trade limit',
    unit: ' trades',
    icon: 'award',
    color: 'text-accent',
    isInverse: true,
  },
};

export const DEFAULT_GOAL_TARGETS: Record<string, Record<string, number>> = {
  weekly: { profit: 500, winRate: 65, maxDrawdown: 3, maxTrades: 8 },
  monthly: { profit: 2000, winRate: 70, maxDrawdown: 10, maxTrades: 30 },
};
