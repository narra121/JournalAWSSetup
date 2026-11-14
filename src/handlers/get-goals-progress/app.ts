import type { ApiHandler } from '../../shared/types';
import { QueryCommand } from '@aws-sdk/lib-dynamodb';
import { ddb } from '../../shared/dynamo';
import { queryDailyStats } from '../../shared/dailyStats';
import { getUserId } from '../../shared/auth';
import { envelope, errorResponse, ErrorCodes } from '../../shared/validation';
import { aggregateDailyRecords } from '../../shared/stats-aggregator';
import { dict } from '../../shared/metrics/dict';
import { DailyStatsRecord } from '../../shared/metrics/types';

const GOALS_TABLE = process.env.GOALS_TABLE!;
const RULES_TABLE = process.env.RULES_TABLE!;

/**
 * ProjectionExpression for the DailyStats queries of goals progress and goals history. periodProgress reads only the
 * profit (grossProfit - grossLoss), win rate (wins / tradeCount), drawdown (pnlSequence in date order), trade count
 * and brokenRulesCounts of the aggregate; every other aggregator treats a missing field as empty. `#sk` is listed
 * because queryDailyStats defines both placeholders and DynamoDB rejects an unused one.
 */
export const DAILY_STATS_PROJECTION = [
  '#sk', '#date', 'tradeCount', 'wins', 'grossProfit', 'grossLoss', 'pnlSequence', 'brokenRulesCounts',
].join(', ');

export const handler: ApiHandler = async (event) => {
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
      queryDailyStats(userId, accountId, startDate, endDate, DAILY_STATS_PROJECTION),
      periodKey ? queryGoalsByPeriod(userId, periodKey) : queryGoals(userId).then((all) => all.filter((g) => !/^(week|month)#/.test(String(g.goalId)))),
      periodKey ? queryRulesByPeriod(userId, periodKey) : queryRules(userId),
      periodKey ? queryRules(userId) : Promise.resolve([]),
    ]);

    return envelope({
      statusCode: 200,
      data: periodProgress(dailyRecords, goals, rules, allRules, period, accountId, totalCapital),
      message: 'Goals progress retrieved successfully',
    });
  } catch (error: any) {
    console.error('Get goals progress error', { error, userId, accountId, startDate, endDate, period });
    return errorResponse(500, ErrorCodes.INTERNAL_ERROR, 'Failed to retrieve goals progress');
  }
};

/** Goal results and rule compliance of one period from the records, goals and rules already read. Shared with goals history. */
export function periodProgress(
  dailyRecords: DailyStatsRecord[],
  goals: any[],
  rules: any[],
  allRules: any[],
  period: string,
  accountId: string,
  totalCapital?: number,
) {
  const stats = aggregateDailyRecords(dailyRecords, { totalCapital });
  const filteredGoals = filterGoalsByPeriodAndAccount(goals, period, accountId);
  return {
    goalProgress: computeGoalProgress(stats, filteredGoals),
    ruleCompliance: computeRuleCompliance(stats, rules, allRules),
    goals: filteredGoals,
    rules,
  };
}

/**
 * Query all goals for a user. Handles pagination.
 */
export async function queryGoals(userId: string): Promise<any[]> {
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
export async function queryRules(userId: string): Promise<any[]> {
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
 * Goals of `period` that apply to `accountId`; `accountId` null is the period default (`#default-<type>`).
 * A default is only a fallback: it applies to a goal type only while no account goal of that type applies to the view.
 * One account: its own goals, plus the defaults of the types it has no goal for.
 * 'ALL': per type, the account goals summed (percentage types averaged), else the default.
 */
const PERCENTAGE_GOAL_TYPES = new Set(['winRate', 'maxDrawdown']);

function filterGoalsByPeriodAndAccount(goals: any[], period: string, accountId: string): any[] {
  const ofPeriod = goals.filter((g: any) => g.period === period);
  const owned = (g: any) => !!g.accountId && (accountId === 'ALL' || g.accountId === accountId);
  const typesWithAccountGoal = new Set(ofPeriod.filter(owned).map((g: any) => g.goalType));
  const applicable = ofPeriod.filter((g: any) => (g.accountId ? owned(g) : !typesWithAccountGoal.has(g.goalType)));

  if (accountId !== 'ALL') return applicable;

  // Group goals by goalType; average percentage types, sum absolute types
  const grouped = dict<any>();
  const counts = dict<number>();

  for (const g of applicable) {
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
  const targetMap = dict<number>();
  for (const g of filteredGoals) {
    targetMap[g.goalType] = g.target || 0;
  }

  const profitTarget = targetMap['profit'] || 0;
  const winRateTarget = targetMap['winRate'] || 0;
  const drawdownTarget = targetMap['maxDrawdown'] || 0;
  const maxTradesTarget = targetMap['maxTrades'] || 0;

  return {
    profit: computeProgress(stats.totalPnl, profitTarget, false),
    winRate: computeProgress(stats.winRate, winRateTarget, false),
    // No drawdown can be measured without a starting capital (maxDrawdown is null): it counts as no drawdown.
    maxDrawdown: computeProgress(stats.maxDrawdown ?? 0, drawdownTarget, true),
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
    const idToText = dict<string>();
    for (const r of allRules) {
      if (r.ruleId && r.rule) idToText[r.ruleId] = r.rule;
    }

    // Build ruleText → periodRuleId from current period rules
    const textToPeriodId = dict<string>();
    const periodRuleIdSet = new Set<string>();
    for (const r of rules) {
      if (r.rule && r.ruleId) {
        textToPeriodId[r.rule] = r.ruleId;
        periodRuleIdSet.add(r.ruleId);
      }
    }

    // Remap counts: translate base UUIDs to period rule IDs via text
    brokenRulesCounts = dict<number>();
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
