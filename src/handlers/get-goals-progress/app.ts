import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { QueryCommand } from '@aws-sdk/lib-dynamodb';
import { ddb } from '../../shared/dynamo';
import { getUserId } from '../../shared/auth';
import { envelope, errorResponse, ErrorCodes } from '../../shared/validation';
import { aggregateDailyRecords } from '../../shared/stats-aggregator';
import { DailyStatsRecord } from '../../shared/metrics/types';

const DAILY_STATS_TABLE = process.env.DAILY_STATS_TABLE!;
const GOALS_TABLE = process.env.GOALS_TABLE!;
const RULES_TABLE = process.env.RULES_TABLE!;

export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  const userId = getUserId(event);
  if (!userId) {
    return errorResponse(401, ErrorCodes.UNAUTHORIZED, 'Unauthorized');
  }

  const query = event.queryStringParameters || {};
  const accountId = query.accountId;
  const startDate = query.startDate;
  const endDate = query.endDate;
  const period = query.period;

  if (!accountId || !startDate || !endDate || !period) {
    return errorResponse(400, ErrorCodes.VALIDATION_ERROR, 'accountId, startDate, endDate, and period are required');
  }

  if (period !== 'weekly' && period !== 'monthly') {
    return errorResponse(400, ErrorCodes.VALIDATION_ERROR, "period must be 'weekly' or 'monthly'");
  }

  try {
    // Run all 3 queries in parallel
    const [dailyRecords, goals, rules] = await Promise.all([
      accountId === 'ALL'
        ? queryAllAccounts(userId, startDate, endDate)
        : querySingleAccount(userId, accountId, startDate, endDate),
      queryGoals(userId),
      queryRules(userId),
    ]);

    // Aggregate daily records into stats
    const stats = aggregateDailyRecords(dailyRecords, {});

    // Filter and group goals by period and account
    const filteredGoals = filterGoalsByPeriodAndAccount(goals, period, accountId);

    // Compute goal progress
    const goalProgress = computeGoalProgress(stats, filteredGoals);

    // Compute rule compliance
    const ruleCompliance = computeRuleCompliance(stats, rules);

    return envelope({
      statusCode: 200,
      data: {
        goalProgress,
        ruleCompliance,
        goals: filteredGoals,
        rules,
      },
      message: 'Goals progress retrieved successfully',
    });
  } catch (error: any) {
    console.error('Get goals progress error', { error, userId, accountId, startDate, endDate, period });
    return errorResponse(500, ErrorCodes.INTERNAL_ERROR, 'Failed to retrieve goals progress', error.message);
  }
};

/**
 * Query all accounts using the GSI (stats-by-date-gsi).
 * PK = userId, SK = date BETWEEN startDate AND endDate.
 * Handles pagination via LastEvaluatedKey.
 */
async function queryAllAccounts(
  userId: string,
  startDate: string,
  endDate: string,
): Promise<DailyStatsRecord[]> {
  const records: DailyStatsRecord[] = [];
  let exclusiveStartKey: Record<string, any> | undefined;

  do {
    const result = await ddb.send(
      new QueryCommand({
        TableName: DAILY_STATS_TABLE,
        IndexName: 'stats-by-date-gsi',
        KeyConditionExpression: 'userId = :userId AND #date BETWEEN :startDate AND :endDate',
        ExpressionAttributeNames: { '#date': 'date' },
        ExpressionAttributeValues: {
          ':userId': userId,
          ':startDate': startDate,
          ':endDate': endDate,
        },
        ExclusiveStartKey: exclusiveStartKey,
      }),
    );

    if (result.Items) {
      records.push(...(result.Items as DailyStatsRecord[]));
    }

    exclusiveStartKey = result.LastEvaluatedKey;
  } while (exclusiveStartKey);

  return records;
}

/**
 * Query a single account using the main table.
 * PK = userId, SK BETWEEN "accountId#startDate" AND "accountId#endDate".
 * Handles pagination via LastEvaluatedKey.
 */
async function querySingleAccount(
  userId: string,
  accountId: string,
  startDate: string,
  endDate: string,
): Promise<DailyStatsRecord[]> {
  const records: DailyStatsRecord[] = [];
  let exclusiveStartKey: Record<string, any> | undefined;

  do {
    const result = await ddb.send(
      new QueryCommand({
        TableName: DAILY_STATS_TABLE,
        KeyConditionExpression: 'userId = :userId AND sk BETWEEN :skStart AND :skEnd',
        ExpressionAttributeValues: {
          ':userId': userId,
          ':skStart': `${accountId}#${startDate}`,
          ':skEnd': `${accountId}#${endDate}`,
        },
        ExclusiveStartKey: exclusiveStartKey,
      }),
    );

    if (result.Items) {
      records.push(...(result.Items as DailyStatsRecord[]));
    }

    exclusiveStartKey = result.LastEvaluatedKey;
  } while (exclusiveStartKey);

  return records;
}

/**
 * Query all goals for a user. Handles pagination.
 */
async function queryGoals(userId: string): Promise<any[]> {
  const items: any[] = [];
  let exclusiveStartKey: Record<string, any> | undefined;

  do {
    const result = await ddb.send(
      new QueryCommand({
        TableName: GOALS_TABLE,
        KeyConditionExpression: 'userId = :u',
        ExpressionAttributeValues: { ':u': userId },
        ExclusiveStartKey: exclusiveStartKey,
      }),
    );

    if (result.Items) {
      items.push(...result.Items);
    }

    exclusiveStartKey = result.LastEvaluatedKey;
  } while (exclusiveStartKey);

  return items;
}

/**
 * Query all rules for a user. Handles pagination.
 */
async function queryRules(userId: string): Promise<any[]> {
  const items: any[] = [];
  let exclusiveStartKey: Record<string, any> | undefined;

  do {
    const result = await ddb.send(
      new QueryCommand({
        TableName: RULES_TABLE,
        KeyConditionExpression: 'userId = :u',
        ExpressionAttributeValues: { ':u': userId },
        ExclusiveStartKey: exclusiveStartKey,
      }),
    );

    if (result.Items) {
      items.push(...result.Items);
    }

    exclusiveStartKey = result.LastEvaluatedKey;
  } while (exclusiveStartKey);

  return items;
}

/**
 * Filter goals by period and account.
 * If accountId='ALL': group goals by goalType, sum targets across accounts.
 * If specific account: filter goals where accountId matches and period matches.
 */
function filterGoalsByPeriodAndAccount(goals: any[], period: string, accountId: string): any[] {
  if (accountId === 'ALL') {
    // Group goals by goalType, sum targets across all accounts for this period
    const grouped: Record<string, any> = {};

    for (const g of goals) {
      if (g.period !== period) continue;

      const type = g.goalType;
      if (!grouped[type]) {
        grouped[type] = { ...g, target: 0 };
      }
      grouped[type].target += (g.target || 0);
    }

    return Object.values(grouped);
  }

  // Specific account: filter by accountId and period
  return goals.filter((g: any) => g.accountId === accountId && g.period === period);
}

/**
 * Compute progress for a single goal metric.
 * isInverse: true means lower is better (e.g. maxDrawdown, tradeCount limit).
 */
function computeProgress(current: number, target: number, isInverse: boolean) {
  const progress = target > 0 ? Math.min((current / target) * 100, 100) : 0;
  const achieved = isInverse ? current <= target : current >= target;
  return {
    current: Math.round(current * 100) / 100,
    target,
    progress: Math.round(progress * 100) / 100,
    achieved,
  };
}

/**
 * Compute goal progress for each goal type based on aggregated stats.
 */
function computeGoalProgress(stats: any, filteredGoals: any[]) {
  // Extract targets from filtered goals by type
  const targetMap: Record<string, number> = {};
  for (const g of filteredGoals) {
    targetMap[g.goalType] = g.target || 0;
  }

  const profitTarget = targetMap['profit'] || 0;
  const winRateTarget = targetMap['winRate'] || 0;
  const drawdownTarget = targetMap['maxDrawdown'] || 0;
  const maxTradesTarget = targetMap['tradeCount'] || 0;

  return {
    profit: computeProgress(stats.totalPnl, profitTarget, false),
    winRate: computeProgress(stats.winRate, winRateTarget, false),
    maxDrawdown: computeProgress(stats.maxDrawdown, drawdownTarget, true),
    tradeCount: computeProgress(stats.totalTrades, maxTradesTarget, true),
  };
}

/**
 * Compute rule compliance from broken rules in stats and active rules.
 */
function computeRuleCompliance(stats: any, rules: any[]) {
  const brokenRulesCounts: Record<string, number> = stats.brokenRulesCounts || {};
  const brokenRuleIds = new Set(
    Object.entries(brokenRulesCounts)
      .filter(([, count]) => (count as number) > 0)
      .map(([ruleId]) => ruleId),
  );

  const activeRules = rules.filter((r: any) => r.isActive !== false);
  const followedCount = activeRules.filter((r: any) => !brokenRuleIds.has(r.ruleId)).length;

  return {
    totalActiveRules: activeRules.length,
    followedCount,
    brokenCount: activeRules.length - followedCount,
    complianceRate: activeRules.length > 0
      ? Math.round((followedCount / activeRules.length) * 100 * 100) / 100
      : 100,
    brokenRulesCounts,
  };
}
