import { APIGatewayProxyHandlerV2 } from 'aws-lambda';
import { ddb } from '../../shared/dynamo';
import { PutCommand } from '@aws-sdk/lib-dynamodb';
import { v4 as uuid } from 'uuid';
import { errorResponse, envelope, ErrorCodes } from '../../shared/validation';
import { makeLogger } from '../../shared/logger';
import { getUserId } from '../../shared/auth';

const GOALS_TABLE = process.env.GOALS_TABLE!;

const VALID_GOAL_TYPES = ['profit', 'winRate', 'maxDrawdown', 'maxTrades'] as const;
const VALID_PERIODS = ['weekly', 'monthly'] as const;

type GoalType = typeof VALID_GOAL_TYPES[number];

const GOAL_TYPE_CONFIG: Record<GoalType, {
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
    isInverse: false
  },
  winRate: {
    title: 'Win Rate',
    description: 'Maintain win rate goal',
    unit: '%',
    icon: 'trending-up',
    color: 'text-success',
    isInverse: false
  },
  maxDrawdown: {
    title: 'Max Drawdown',
    description: 'Keep drawdown under limit',
    unit: '%',
    icon: 'shield',
    color: 'text-warning',
    isInverse: true
  },
  maxTrades: {
    title: 'Max Trades',
    description: 'Stay under trade limit',
    unit: ' trades',
    icon: 'award',
    color: 'text-accent',
    isInverse: true
  }
};

export const handler: APIGatewayProxyHandlerV2 = async (event) => {
  const userId = getUserId(event);
  const log = makeLogger({ requestId: event.requestContext.requestId, userId });

  log.info('create-goal invoked');

  if (!userId) {
    log.warn('unauthorized request');
    return errorResponse(401, ErrorCodes.UNAUTHORIZED, 'Unauthorized');
  }

  if (!event.body) {
    log.warn('missing body');
    return errorResponse(400, ErrorCodes.VALIDATION_ERROR, 'Missing body');
  }

  let data: any;
  try {
    data = JSON.parse(event.body);
  } catch (e) {
    log.warn('invalid json', { error: (e as any)?.message });
    return errorResponse(400, ErrorCodes.VALIDATION_ERROR, 'Invalid JSON');
  }

  if (!data.goalType || !VALID_GOAL_TYPES.includes(data.goalType)) {
    log.warn('invalid goalType', { goalType: data.goalType });
    return errorResponse(400, ErrorCodes.VALIDATION_ERROR, 'goalType is required and must be one of: profit, winRate, maxDrawdown, maxTrades');
  }

  if (!data.period || !VALID_PERIODS.includes(data.period)) {
    log.warn('invalid period', { period: data.period });
    return errorResponse(400, ErrorCodes.VALIDATION_ERROR, 'period is required and must be one of: weekly, monthly');
  }

  if (data.target === undefined || data.target === null || typeof data.target !== 'number') {
    log.warn('invalid target', { target: data.target });
    return errorResponse(400, ErrorCodes.VALIDATION_ERROR, 'target is required and must be a number');
  }

  try {
    const goalId = uuid();
    const now = new Date().toISOString();
    const config = GOAL_TYPE_CONFIG[data.goalType as GoalType];

    const goal = {
      userId,
      goalId,
      accountId: data.accountId || null,
      goalType: data.goalType,
      period: data.period,
      target: data.target,
      title: config.title,
      description: config.description,
      unit: config.unit,
      icon: config.icon,
      color: config.color,
      isInverse: config.isInverse,
      createdAt: now,
      updatedAt: now
    };

    await ddb.send(new PutCommand({
      TableName: GOALS_TABLE,
      Item: goal
    }));

    log.info('goal created', { goalId, goalType: data.goalType, period: data.period });

    return envelope({ statusCode: 201, data: { goal }, message: 'Goal created successfully' });
  } catch (error: any) {
    log.error('failed to create goal', { error: error.message });
    return errorResponse(500, ErrorCodes.INTERNAL_ERROR, 'Failed to create goal');
  }
};
