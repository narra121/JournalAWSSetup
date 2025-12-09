import { APIGatewayProxyHandlerV2 } from 'aws-lambda';
import { ddb } from '../../shared/dynamo';
import { QueryCommand, BatchWriteCommand } from '@aws-sdk/lib-dynamodb';
import { errorResponse, envelope, ErrorCodes } from '../../shared/validation';
import { makeLogger } from '../../shared/logger';
import { v4 as uuid } from 'uuid';

const GOALS_TABLE = process.env.GOALS_TABLE!;
const ACCOUNTS_TABLE = process.env.ACCOUNTS_TABLE!;

// Default goal types with their configurations
const DEFAULT_GOAL_TYPES = [
  {
    goalType: 'profit',
    title: 'Profit Target',
    description: 'Reach your profit goal',
    unit: '$',
    icon: 'target',
    color: 'text-primary',
    isInverse: false,
    weeklyTarget: 500,
    monthlyTarget: 2000
  },
  {
    goalType: 'winRate',
    title: 'Win Rate',
    description: 'Maintain win rate goal',
    unit: '%',
    icon: 'trending-up',
    color: 'text-success',
    isInverse: false,
    weeklyTarget: 65,
    monthlyTarget: 70
  },
  {
    goalType: 'maxDrawdown',
    title: 'Max Drawdown',
    description: 'Keep drawdown under limit',
    unit: '%',
    icon: 'shield',
    color: 'text-warning',
    isInverse: true,
    weeklyTarget: 3,
    monthlyTarget: 10
  },
  {
    goalType: 'maxTrades',
    title: 'Max Trades',
    description: 'Stay under trade limit',
    unit: ' trades',
    icon: 'award',
    color: 'text-accent',
    isInverse: true,
    weeklyTarget: 8,
    monthlyTarget: 30
  }
];

async function ensureDefaultGoals(userId: string, accountId: string, existingGoals: any[]): Promise<any[]> {
  // Check if goals exist for this account
  const accountGoals = existingGoals.filter(g => g.accountId === accountId);
  if (accountGoals.length > 0) {
    return existingGoals;
  }

  const now = new Date().toISOString();
  const newGoals: any[] = [];

  // Create weekly and monthly goals for each goal type
  for (const goalType of DEFAULT_GOAL_TYPES) {
    // Weekly goal
    newGoals.push({
      userId,
      goalId: uuid(),
      accountId,
      goalType: goalType.goalType,
      period: 'weekly',
      target: goalType.weeklyTarget,
      title: goalType.title,
      description: goalType.description,
      unit: goalType.unit,
      icon: goalType.icon,
      color: goalType.color,
      isInverse: goalType.isInverse,
      createdAt: now,
      updatedAt: now
    });

    // Monthly goal
    newGoals.push({
      userId,
      goalId: uuid(),
      accountId,
      goalType: goalType.goalType,
      period: 'monthly',
      target: goalType.monthlyTarget,
      title: goalType.title,
      description: goalType.description,
      unit: goalType.unit,
      icon: goalType.icon,
      color: goalType.color,
      isInverse: goalType.isInverse,
      createdAt: now,
      updatedAt: now
    });
  }

  // Batch write all default goals
  if (newGoals.length > 0) {
    await ddb.send(new BatchWriteCommand({
      RequestItems: {
        [GOALS_TABLE]: newGoals.map(goal => ({ PutRequest: { Item: goal } }))
      }
    }));

    console.log('Default goals created', { userId, accountId, count: newGoals.length });
  }

  return [...existingGoals, ...newGoals];
}

export const handler: APIGatewayProxyHandlerV2 = async (event) => {
  const rc: any = event.requestContext as any;
  const claims = rc?.authorizer?.jwt?.claims || {};
  const userId = claims.sub;
  const log = makeLogger({ requestId: event.requestContext.requestId, userId });
  
  log.info('list-goals invoked');
  
  if (!userId) {
    log.warn('unauthorized request');
    return errorResponse(401, ErrorCodes.UNAUTHORIZED, 'Unauthorized');
  }

  try {
    // Fetch user's accounts and goals in parallel
    const [accountsResult, goalsResult] = await Promise.all([
      ddb.send(new QueryCommand({
        TableName: ACCOUNTS_TABLE,
        KeyConditionExpression: 'userId = :userId',
        ExpressionAttributeValues: { ':userId': userId }
      })),
      ddb.send(new QueryCommand({
        TableName: GOALS_TABLE,
        KeyConditionExpression: 'userId = :userId',
        ExpressionAttributeValues: { ':userId': userId }
      }))
    ]);

    const accounts = accountsResult.Items || [];
    let goals = goalsResult.Items || [];

    // Ensure default goals exist for each account
    for (const account of accounts) {
      goals = await ensureDefaultGoals(userId, account.accountId, goals);
    }

    log.info('goals listed', { count: goals.length, accountsCount: accounts.length });
    
    return envelope({ 
      statusCode: 200, 
      data: { 
        goals,
        meta: {
          goalsCount: goals.length,
          accountsCount: accounts.length
        }
      } 
    });
  } catch (error: any) {
    log.error('failed to list goals', { error: error.message });
    return errorResponse(500, ErrorCodes.INTERNAL_ERROR, 'Failed to retrieve goals');
  }
};

