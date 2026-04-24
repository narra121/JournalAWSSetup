import { APIGatewayProxyHandlerV2 } from 'aws-lambda';
import { QueryCommand } from '@aws-sdk/lib-dynamodb';
import { ddb } from '../../shared/dynamo';
import { getUserId } from '../../shared/auth';
import { envelope, errorResponse, ErrorCodes } from '../../shared/validation';
import { aggregateDailyRecords } from '../../shared/stats-aggregator';
import { DailyStatsRecord } from '../../shared/metrics/types';

const DAILY_STATS_TABLE = process.env.DAILY_STATS_TABLE!;
const GOALS_TABLE = process.env.GOALS_TABLE!;
const RULES_TABLE = process.env.RULES_TABLE!;

/**
 * ProjectionExpression for DailyStats queries in this handler.
 * Only fetches fields needed by aggregateDailyRecords() — avoids transferring
 * the full 30+ attribute records when only aggregation fields are needed.
 *
 * Fields accessed by aggregation processors:
 *   CoreStats: tradeCount, wins, losses, breakeven, grossProfit, grossLoss, totalVolume
 *   Extremes: bestTrade, worstTrade
 *   RiskReward: sumRiskReward, riskRewardCount
 *   Duration: totalDurationHours, durationTradeCount, minDurationHours, maxDurationHours, durationBuckets
 *   Distributions: symbolDistribution, strategyDistribution, sessionDistribution, outcomeDistribution
 *   Hourly: hourlyBreakdown
 *   PnlSequence: pnlSequence, equityCurvePoints, date, totalPnl
 *   DayOfWeek: dayOfWeek, tradeCount, wins, totalPnl
 *   Mistakes: mistakesDistribution
 *   Lessons: lessonsDistribution
 *   BrokenRules: brokenRulesCounts, brokenRulesDistribution
 */
const DAILY_STATS_PROJECTION_NAMES: Record<string, string> = {
  '#d': 'date',
  '#s': 'sk',
};

const DAILY_STATS_PROJECTION = [
  'userId', '#s', '#d', 'accountId', 'dayOfWeek',
  'tradeCount', 'wins', 'losses', 'breakeven', 'grossProfit', 'grossLoss', 'totalPnl', 'totalVolume',
  'bestTrade', 'worstTrade',
  'sumRiskReward', 'riskRewardCount',
  'totalDurationHours', 'durationTradeCount', 'minDurationHours', 'maxDurationHours', 'durationBuckets',
  'symbolDistribution', 'strategyDistribution', 'sessionDistribution', 'outcomeDistribution',
  'hourlyBreakdown',
  'pnlSequence', 'equityCurvePoints',
  'mistakesDistribution', 'lessonsDistribution',
  'brokenRulesCounts', 'brokenRulesDistribution',
].join(', ');

export const handler: APIGatewayProxyHandlerV2 = async (event) => {
  const userId = getUserId(event);
  if (!userId) {
    return errorResponse(401, ErrorCodes.UNAUTHORIZED, 'Unauthorized');
  }

  const query = event.queryStringParameters || {};
  const accountId = query.accountId;
  const startDate = query.startDate;
  const endDate = query.endDate;
  const period = query.period;
  const periodKey = query.periodKey || null;
  const parsedCapital = query.totalCapital ? parseFloat(query.totalCapital) : undefined;
  const totalCapital = parsedCapital !== undefined && Number.isFinite(parsedCapital) ? parsedCapital : undefined;

  if (!accountId || !startDate || !endDate || !period) {
    return errorResponse(400, ErrorCodes.VALIDATION_ERROR, 'accountId, startDate, endDate, and period are required');
  }

  if (period !== 'weekly' && period !== 'monthly') {
    return errorResponse(400, ErrorCodes.VALIDATION_ERROR, "period must be 'weekly' or 'monthly'");
  }

  try {
    // Run all queries in parallel
    // When periodKey is provided, also fetch all rules so we can map
    // base rule IDs (stored in trades) to period-specific rule IDs.
    const [dailyRecords, goals, rules, allRules] = await Promise.all([
      accountId === 'ALL'
        ? queryAllAccounts(userId, startDate, endDate)
        : querySingleAccount(userId, accountId, startDate, endDate),
      periodKey ? queryGoalsByPeriod(userId, periodKey) : queryGoals(userId),
      periodKey ? queryRulesByPeriod(userId, periodKey) : queryRules(userId),
      periodKey ? queryRules(userId) : Promise.resolve([]),
    ]);

    // Aggregate daily records into stats
    const stats = aggregateDailyRecords(dailyRecords, { totalCapital });

    // Filter and group goals by period and account
    const filteredGoals = filterGoalsByPeriodAndAccount(goals, period, accountId);

    // Compute goal progress
    const goalProgress = computeGoalProgress(stats, filteredGoals);

    // Compute rule compliance
    const ruleCompliance = computeRuleCompliance(stats, rules, allRules);

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
        KeyConditionExpression: 'userId = :userId AND #d BETWEEN :startDate AND :endDate',
        ProjectionExpression: DAILY_STATS_PROJECTION,
        ExpressionAttributeNames: { ...DAILY_STATS_PROJECTION_NAMES },
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
        KeyConditionExpression: 'userId = :userId AND #s BETWEEN :skStart AND :skEnd',
        ProjectionExpression: DAILY_STATS_PROJECTION,
        ExpressionAttributeNames: { ...DAILY_STATS_PROJECTION_NAMES },
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
 * Query goals for a user filtered by periodKey prefix. Handles pagination.
 */
async function queryGoalsByPeriod(userId: string, periodKey: string): Promise<any[]> {
  const items: any[] = [];
  let exclusiveStartKey: Record<string, any> | undefined;
  const prefix = `${periodKey}#`;

  do {
    const result = await ddb.send(
      new QueryCommand({
        TableName: GOALS_TABLE,
        KeyConditionExpression: 'userId = :u AND begins_with(goalId, :prefix)',
        ExpressionAttributeValues: { ':u': userId, ':prefix': prefix },
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
 * Query rules for a user filtered by periodKey prefix. Handles pagination.
 */
async function queryRulesByPeriod(userId: string, periodKey: string): Promise<any[]> {
  const items: any[] = [];
  let exclusiveStartKey: Record<string, any> | undefined;
  const prefix = `${periodKey}#`;

  do {
    const result = await ddb.send(
      new QueryCommand({
        TableName: RULES_TABLE,
        KeyConditionExpression: 'userId = :u AND begins_with(ruleId, :prefix)',
        ExpressionAttributeValues: { ':u': userId, ':prefix': prefix },
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
const PERCENTAGE_GOAL_TYPES = new Set(['winRate', 'maxDrawdown']);

function filterGoalsByPeriodAndAccount(goals: any[], period: string, accountId: string): any[] {
  if (accountId === 'ALL') {
    // Group goals by goalType; average percentage types, sum absolute types
    const grouped: Record<string, any> = {};
    const counts: Record<string, number> = {};

    for (const g of goals) {
      if (g.period !== period) continue;

      const type = g.goalType;
      if (!grouped[type]) {
        grouped[type] = { ...g, target: 0 };
        counts[type] = 0;
      }
      grouped[type].target += (g.target || 0);
      counts[type]++;
    }

    // Average percentage-based types instead of leaving them summed
    for (const type of Object.keys(grouped)) {
      if (PERCENTAGE_GOAL_TYPES.has(type) && counts[type] > 1) {
        grouped[type].target = grouped[type].target / counts[type];
      }
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
  let progress: number;
  if (isInverse) {
    progress = target > 0 ? Math.max(0, Math.min(100, (1 - Math.max(0, current - target) / target) * 100)) : 0;
  } else {
    progress = target > 0 ? Math.min((current / target) * 100, 100) : 0;
  }
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
 *
 * Trades store brokenRuleIds as base rule UUIDs (from BrokenRulesSelect),
 * but period-specific rules have prefixed IDs (e.g. "week#2026-04-07#<uuid>").
 * When allRules is provided, we remap base UUIDs → period rule IDs via text matching.
 */
function computeRuleCompliance(stats: any, rules: any[], allRules: any[] = []) {
  const rawCounts: Record<string, number> = stats.brokenRulesCounts || {};

  // Remap broken rule IDs to period-specific rule IDs when needed
  let brokenRulesCounts = rawCounts;
  if (allRules.length > 0 && rules.length > 0) {
    // Build ruleId → ruleText from all rules (includes base/legacy rules)
    const idToText: Record<string, string> = {};
    for (const r of allRules) {
      if (r.ruleId && r.rule) idToText[r.ruleId] = r.rule;
    }

    // Build ruleText → periodRuleId from current period rules
    const textToPeriodId: Record<string, string> = {};
    const periodRuleIdSet = new Set<string>();
    for (const r of rules) {
      if (r.rule && r.ruleId) {
        textToPeriodId[r.rule] = r.ruleId;
        periodRuleIdSet.add(r.ruleId);
      }
    }

    // Remap counts: translate base UUIDs to period rule IDs via text
    brokenRulesCounts = {};
    for (const [ruleId, count] of Object.entries(rawCounts)) {
      if ((count as number) <= 0) continue;

      // Already a period rule ID — keep as-is
      if (periodRuleIdSet.has(ruleId)) {
        brokenRulesCounts[ruleId] = (brokenRulesCounts[ruleId] || 0) + (count as number);
        continue;
      }

      // Map via text: base ruleId → text → period ruleId
      const text = idToText[ruleId];
      if (text && textToPeriodId[text]) {
        const periodId = textToPeriodId[text];
        brokenRulesCounts[periodId] = (brokenRulesCounts[periodId] || 0) + (count as number);
      } else {
        // No mapping found — keep original
        brokenRulesCounts[ruleId] = (brokenRulesCounts[ruleId] || 0) + (count as number);
      }
    }
  }

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
