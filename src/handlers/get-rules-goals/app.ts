import { APIGatewayProxyHandlerV2 } from 'aws-lambda';
import { ddb } from '../../shared/dynamo';
import { QueryCommand, GetCommand } from '@aws-sdk/lib-dynamodb';
import { errorResponse, envelope, ErrorCodes } from '../../shared/validation';
import { makeLogger } from '../../shared/logger';
import { v4 as uuid } from 'uuid';
import { batchWritePutAll } from '../../shared/batchWrite';
import { getUserId } from '../../shared/auth';

const RULES_TABLE = process.env.RULES_TABLE!;
const GOALS_TABLE = process.env.GOALS_TABLE!;
const USER_PREFERENCES_TABLE = process.env.USER_PREFERENCES_TABLE!;

const DEFAULT_RULES = [
  'Never risk more than 1% per trade',
  'Always set stop loss before entry',
  'No trading during high-impact news',
  'Wait for confirmation before entry',
  'Review trades weekly',
  'Stick to my trading plan'
];

const DEFAULT_GOAL_TARGETS: Record<string, Record<string, number>> = {
  weekly: { profit: 500, winRate: 65, maxDrawdown: 3, maxTrades: 8 },
  monthly: { profit: 2000, winRate: 70, maxDrawdown: 10, maxTrades: 30 },
};

const GOAL_TYPE_CONFIG: Record<string, {
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

function getPreviousPeriodKey(periodKey: string): string {
  if (periodKey.startsWith('week#')) {
    const dateStr = periodKey.replace('week#', '');
    const date = new Date(dateStr + 'T00:00:00Z');
    date.setUTCDate(date.getUTCDate() - 7);
    return `week#${date.toISOString().slice(0, 10)}`;
  } else if (periodKey.startsWith('month#')) {
    const ym = periodKey.replace('month#', '');
    const [y, m] = ym.split('-').map(Number);
    const prev = new Date(Date.UTC(y, m - 2, 1));
    return `month#${prev.getUTCFullYear()}-${String(prev.getUTCMonth() + 1).padStart(2, '0')}`;
  }
  return periodKey;
}

function getPeriodType(periodKey: string): 'weekly' | 'monthly' {
  return periodKey.startsWith('month#') ? 'monthly' : 'weekly';
}

function isLegacyRecord(sk: string): boolean {
  return !sk.startsWith('week#') && !sk.startsWith('month#');
}

function createDefaultRules(userId: string, periodKey: string): any[] {
  const now = new Date().toISOString();
  return DEFAULT_RULES.map(ruleText => ({
    userId,
    ruleId: `${periodKey}#${uuid()}`,
    rule: ruleText,
    completed: false,
    isActive: true,
    createdAt: now,
    updatedAt: now,
  }));
}

function createDefaultGoals(userId: string, periodKey: string): any[] {
  const now = new Date().toISOString();
  const periodType = getPeriodType(periodKey);
  const targets = DEFAULT_GOAL_TARGETS[periodType];

  return Object.entries(targets).map(([goalType, target]) => {
    const config = GOAL_TYPE_CONFIG[goalType];
    return {
      userId,
      goalId: `${periodKey}#${uuid()}`,
      accountId: null,
      goalType,
      period: periodType,
      target,
      title: config.title,
      description: config.description,
      unit: config.unit,
      icon: config.icon,
      color: config.color,
      isInverse: config.isInverse,
      createdAt: now,
      updatedAt: now,
    };
  });
}

async function ensureDefaultRules(userId: string, existingRules: any[]): Promise<any[]> {
  if (existingRules.length > 0) {
    return existingRules; // User already has rules
  }

  // Create default rules (legacy — no periodKey)
  const now = new Date().toISOString();
  const rules = DEFAULT_RULES.map(ruleText => ({
    userId,
    ruleId: uuid(),
    rule: ruleText,
    completed: false,
    isActive: true,
    createdAt: now,
    updatedAt: now
  }));

  // Batch write all default rules
  await batchWritePutAll({ ddb, tableName: RULES_TABLE, items: rules });

  console.log('Default rules created', { userId, count: rules.length });
  return rules;
}

/** Query rules/goals with optional periodKey prefix filter. */
async function queryTable(tableName: string, userId: string, skPrefix?: string): Promise<any[]> {
  const items: any[] = [];
  let exclusiveStartKey: Record<string, any> | undefined;
  const skAttr = tableName === RULES_TABLE ? 'ruleId' : 'goalId';

  do {
    const params: any = {
      TableName: tableName,
      ExclusiveStartKey: exclusiveStartKey,
    };

    if (skPrefix) {
      params.KeyConditionExpression = 'userId = :userId AND begins_with(#sk, :prefix)';
      params.ExpressionAttributeNames = { '#sk': skAttr };
      params.ExpressionAttributeValues = { ':userId': userId, ':prefix': skPrefix };
    } else {
      params.KeyConditionExpression = 'userId = :userId';
      params.ExpressionAttributeValues = { ':userId': userId };
    }

    const result = await ddb.send(new QueryCommand(params));
    if (result.Items) {
      items.push(...result.Items);
    }
    exclusiveStartKey = result.LastEvaluatedKey;
  } while (exclusiveStartKey);

  return items;
}

/** Fetch legacy records (SK that doesn't start with week# or month#). */
async function queryLegacyRecords(tableName: string, userId: string): Promise<any[]> {
  // DynamoDB does not allow FilterExpression on primary key attributes (ruleId/goalId
  // are sort keys). Query all records and filter client-side instead.
  const items: any[] = [];
  let exclusiveStartKey: Record<string, any> | undefined;
  const skAttr = tableName === RULES_TABLE ? 'ruleId' : 'goalId';

  do {
    const result = await ddb.send(new QueryCommand({
      TableName: tableName,
      KeyConditionExpression: 'userId = :userId',
      ExpressionAttributeValues: {
        ':userId': userId,
      },
      ExclusiveStartKey: exclusiveStartKey,
    }));

    if (result.Items) {
      items.push(...result.Items);
    }
    exclusiveStartKey = result.LastEvaluatedKey;
  } while (exclusiveStartKey);

  // Filter client-side: legacy records have sort keys that don't start with 'week#' or 'month#'
  return items.filter((item) => {
    const sk = item[skAttr] as string;
    return !sk.startsWith('week#') && !sk.startsWith('month#');
  });
}

/** Check if user has carry-forward enabled (default = true). */
async function getCarryForward(userId: string): Promise<boolean> {
  try {
    const result = await ddb.send(new GetCommand({
      TableName: USER_PREFERENCES_TABLE,
      Key: { userId },
    }));
    if (result.Item && result.Item.carryForwardGoalsRules !== undefined) {
      return result.Item.carryForwardGoalsRules === true;
    }
    return true; // default is ON
  } catch {
    return true; // default on error
  }
}

export const handler: APIGatewayProxyHandlerV2 = async (event) => {
  const userId = getUserId(event);
  const log = makeLogger({ requestId: event.requestContext.requestId, userId });

  log.info('get-rules-goals invoked');

  if (!userId) {
    log.warn('unauthorized request');
    return errorResponse(401, ErrorCodes.UNAUTHORIZED, 'Unauthorized');
  }

  if (!RULES_TABLE || !GOALS_TABLE) {
    log.error('rules/goals table env vars are not configured', {
      hasRulesTable: !!RULES_TABLE,
      hasGoalsTable: !!GOALS_TABLE
    });
    return errorResponse(500, ErrorCodes.INTERNAL_ERROR, 'Rules/goals tables are not configured');
  }

  const periodKey = event.queryStringParameters?.periodKey || null;
  const isCurrentPeriod = event.queryStringParameters?.currentPeriod === 'true';

  try {
    // ── No periodKey: backward-compatible global fetch ──
    if (!periodKey) {
      const [rulesResult, goalsResult] = await Promise.all([
        ddb.send(new QueryCommand({
          TableName: RULES_TABLE,
          KeyConditionExpression: 'userId = :userId',
          ExpressionAttributeValues: { ':userId': userId }
        })),
        ddb.send(new QueryCommand({
          TableName: GOALS_TABLE,
          KeyConditionExpression: 'userId = :userId',
          ExpressionAttributeValues: { ':userId': userId }
        }))
      ]);

      let rules = rulesResult.Items || [];
      const goals = goalsResult.Items || [];

      // Ensure user has default rules if none exist (legacy behavior)
      rules = await ensureDefaultRules(userId, rules);

      log.info('rules and goals fetched', {
        rulesCount: rules.length,
        goalsCount: goals.length
      });

      return envelope({
        statusCode: 200,
        data: {
          rules,
          goals,
          meta: {
            rulesCount: rules.length,
            goalsCount: goals.length
          }
        },
        message: 'Rules and goals retrieved'
      });
    }

    // ── periodKey provided: period-specific fetch ──
    const prefix = `${periodKey}#`;
    const [rules, goals] = await Promise.all([
      queryTable(RULES_TABLE, userId, prefix),
      queryTable(GOALS_TABLE, userId, prefix),
    ]);

    // Records found for this period — return them
    if (rules.length > 0 || goals.length > 0) {
      log.info('period rules and goals fetched', {
        periodKey,
        rulesCount: rules.length,
        goalsCount: goals.length,
      });

      return envelope({
        statusCode: 200,
        data: {
          rules,
          goals,
          meta: {
            rulesCount: rules.length,
            goalsCount: goals.length,
            periodKey,
          },
        },
        message: 'Rules and goals retrieved',
      });
    }

    // No records for this period
    // Past period — return empty (read-only)
    if (!isCurrentPeriod) {
      log.info('no records for past period, returning empty', { periodKey });
      return envelope({
        statusCode: 200,
        data: {
          rules: [],
          goals: [],
          meta: {
            rulesCount: 0,
            goalsCount: 0,
            periodKey,
          },
        },
        message: 'Rules and goals retrieved',
      });
    }

    // Current period with no records — clone-on-write
    const carryForward = await getCarryForward(userId);
    let newRules: any[] = [];
    let newGoals: any[] = [];

    if (carryForward) {
      // Try previous period first
      const prevPeriodKey = getPreviousPeriodKey(periodKey);
      const prevPrefix = `${prevPeriodKey}#`;
      const [prevRules, prevGoals] = await Promise.all([
        queryTable(RULES_TABLE, userId, prevPrefix),
        queryTable(GOALS_TABLE, userId, prevPrefix),
      ]);

      if (prevRules.length > 0 || prevGoals.length > 0) {
        // Clone from previous period
        newRules = cloneRules(prevRules, userId, periodKey);
        newGoals = cloneGoals(prevGoals, userId, periodKey);
      } else {
        // Try legacy records
        const [legacyRules, legacyGoals] = await Promise.all([
          queryLegacyRecords(RULES_TABLE, userId),
          queryLegacyRecords(GOALS_TABLE, userId),
        ]);

        if (legacyRules.length > 0 || legacyGoals.length > 0) {
          newRules = cloneRules(legacyRules, userId, periodKey);
          newGoals = cloneGoals(legacyGoals, userId, periodKey);
        } else {
          // No source records at all — create defaults
          newRules = createDefaultRules(userId, periodKey);
          newGoals = createDefaultGoals(userId, periodKey);
        }
      }
    } else {
      // Carry-forward OFF — create defaults
      newRules = createDefaultRules(userId, periodKey);
      newGoals = createDefaultGoals(userId, periodKey);
    }

    // Batch write new records
    const writes: Promise<void>[] = [];
    if (newRules.length > 0) {
      writes.push(batchWritePutAll({ ddb, tableName: RULES_TABLE, items: newRules }));
    }
    if (newGoals.length > 0) {
      writes.push(batchWritePutAll({ ddb, tableName: GOALS_TABLE, items: newGoals }));
    }
    await Promise.all(writes);

    log.info('clone-on-write completed', {
      periodKey,
      carryForward,
      rulesCount: newRules.length,
      goalsCount: newGoals.length,
    });

    return envelope({
      statusCode: 200,
      data: {
        rules: newRules,
        goals: newGoals,
        meta: {
          rulesCount: newRules.length,
          goalsCount: newGoals.length,
          periodKey,
          cloned: true,
        },
      },
      message: 'Rules and goals retrieved',
    });
  } catch (error: any) {
    log.error('failed to fetch rules and goals', { error: error.message });
    return errorResponse(500, ErrorCodes.INTERNAL_ERROR, 'Failed to retrieve rules and goals');
  }
};

function cloneRules(sourceRules: any[], userId: string, periodKey: string): any[] {
  const now = new Date().toISOString();
  return sourceRules.map(rule => ({
    ...rule,
    userId,
    ruleId: `${periodKey}#${uuid()}`,
    createdAt: now,
    updatedAt: now,
  }));
}

function cloneGoals(sourceGoals: any[], userId: string, periodKey: string): any[] {
  const now = new Date().toISOString();
  return sourceGoals.map(goal => ({
    ...goal,
    userId,
    goalId: `${periodKey}#${uuid()}`,
    createdAt: now,
    updatedAt: now,
  }));
}

// Export helpers for testing
export { getPreviousPeriodKey, getPeriodType, isLegacyRecord, createDefaultRules, createDefaultGoals };
