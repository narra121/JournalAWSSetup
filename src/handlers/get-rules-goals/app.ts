import type { ApiHandler } from '../../shared/types';
import { ddb } from '../../shared/dynamo';
import { QueryCommand, GetCommand } from '@aws-sdk/lib-dynamodb';
import { errorResponse, envelope, ErrorCodes } from '../../shared/validation';
import { makeLogger } from '../../shared/logger';
import { v4 as uuid } from 'uuid';
import { batchWritePutAll } from '../../shared/batchWrite';
import { getUserId } from '../../shared/auth';
import { GOAL_TYPE_CONFIG, DEFAULT_GOAL_TARGETS } from '../../shared/goalDefaults';
import { dayOf, getUserTimeZone, isCalendarDay } from '../../shared/timezone';

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

/** `week#YYYY-MM-DD` or `month#YYYY-MM`, with a real date. */
function isValidPeriodKey(periodKey: string): boolean {
  if (!/^(week#\d{4}-\d{2}-\d{2}|month#\d{4}-\d{2})$/.test(periodKey)) return false;
  const [kind, value] = periodKey.split('#');
  return kind === 'week' ? isCalendarDay(value) : /^\d{4}-(0[1-9]|1[0-2])$/.test(value);
}

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

/** True when `day` (YYYY-MM-DD) lies in the period: a week key holds the 7 days from its first day, a month key its month. */
function periodHoldsDay(periodKey: string, day: string): boolean {
  if (periodKey.startsWith('month#')) return day.startsWith(`${periodKey.slice('month#'.length)}-`);
  const first = Date.parse(`${periodKey.slice('week#'.length)}T00:00:00Z`);
  const offset = Date.parse(`${day}T00:00:00Z`) - first;
  return offset >= 0 && offset < 7 * 86_400_000;
}

/** Whether today, in the user's time zone, is in the period; only the current period may be written by a GET. */
async function isCurrentPeriod(userId: string, periodKey: string): Promise<boolean> {
  const timeZone = await getUserTimeZone(userId).catch(() => null);
  return periodHoldsDay(periodKey, dayOf(new Date().toISOString(), timeZone));
}

function isLegacyRecord(sk: string): boolean {
  return !sk.startsWith('week#') && !sk.startsWith('month#');
}

function createDefaultRules(userId: string, periodKey: string): any[] {
  const now = new Date().toISOString();
  // Ids are derived (not random) so two concurrent first reads of a period write the same records instead of duplicates.
  return DEFAULT_RULES.map((ruleText, index) => ({
    userId,
    ruleId: `${periodKey}#default-${index}`,
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
    const config = GOAL_TYPE_CONFIG[goalType as keyof typeof GOAL_TYPE_CONFIG];
    return {
      userId,
      goalId: `${periodKey}#default-${goalType}`,
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
  // The sort keys (ruleId/goalId) cannot be filtered by DynamoDB, so read them all and filter here.
  const skAttr = tableName === RULES_TABLE ? 'ruleId' : 'goalId';
  return (await queryTable(tableName, userId)).filter((item) => isLegacyRecord(item[skAttr] as string));
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

export const handler: ApiHandler = async (event) => {
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
  // The same shape create-rule and create-goal accept. Anything else would write junk period records on a GET.
  if (periodKey !== null && !isValidPeriodKey(periodKey)) {
    log.warn('invalid periodKey', { periodKey });
    return errorResponse(400, ErrorCodes.VALIDATION_ERROR, 'Invalid periodKey format');
  }
  // The client's claim; it only counts once the server has checked it against the clock (see below).
  const currentPeriodClaimed = event.queryStringParameters?.currentPeriod === 'true';

  try {
    // ── No periodKey: backward-compatible global fetch ──
    if (!periodKey) {
      let [rules, goals] = await Promise.all([queryTable(RULES_TABLE, userId), queryTable(GOALS_TABLE, userId)]);

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
    // Past, future or unclaimed period — return empty (read-only)
    if (!currentPeriodClaimed || !(await isCurrentPeriod(userId, periodKey))) {
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

    // Current period with no records: the records it would start with, not stored (a GET never writes).
    // The first rule or goal write to the period stores them (materializePeriod).
    const { rules: newRules, goals: newGoals } = await planPeriod(userId, periodKey);
    log.info('current period not stored yet, returning its starting records', { periodKey, rulesCount: newRules.length, goalsCount: newGoals.length });

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

/** The part of a period-scoped id after the period key (`week#2026-11-02#<tail>`), or the whole legacy id. */
/**
 * The records the current period starts with: the previous period's, else the ones made before periods existed, else the
 * starter rules. No goals are made up: a goal exists only once the user sets one.
 */
async function planPeriod(userId: string, periodKey: string): Promise<{ rules: any[]; goals: any[] }> {
  if (await getCarryForward(userId)) {
    const prevPrefix = `${getPreviousPeriodKey(periodKey)}#`;
    const [prevRules, prevGoals] = await Promise.all([queryTable(RULES_TABLE, userId, prevPrefix), queryTable(GOALS_TABLE, userId, prevPrefix)]);
    if (prevRules.length > 0 || prevGoals.length > 0) return { rules: cloneRules(prevRules, userId, periodKey), goals: cloneGoals(prevGoals, userId, periodKey) };
    const [legacyRules, legacyGoals] = await Promise.all([queryLegacyRecords(RULES_TABLE, userId), queryLegacyRecords(GOALS_TABLE, userId)]);
    if (legacyRules.length > 0 || legacyGoals.length > 0) return { rules: cloneRules(legacyRules, userId, periodKey), goals: cloneGoals(legacyGoals, userId, periodKey) };
  }
  return { rules: createDefaultRules(userId, periodKey), goals: [] };
}

/**
 * Stores the starting records of the current period before its first rule or goal write, so an edit of a record the GET
 * showed finds it, and a new record does not hide the others. Nothing happens for a stored, past or future period.
 */
export async function materializePeriod(userId: string, periodKey: string): Promise<void> {
  if (!isValidPeriodKey(periodKey)) return;
  const prefix = `${periodKey}#`;
  const [rules, goals] = await Promise.all([queryTable(RULES_TABLE, userId, prefix), queryTable(GOALS_TABLE, userId, prefix)]);
  if (rules.length > 0 || goals.length > 0 || !(await isCurrentPeriod(userId, periodKey))) return;
  const plan = await planPeriod(userId, periodKey);
  await Promise.all([
    plan.rules.length > 0 ? batchWritePutAll({ ddb, tableName: RULES_TABLE, items: plan.rules }) : undefined,
    plan.goals.length > 0 ? batchWritePutAll({ ddb, tableName: GOALS_TABLE, items: plan.goals }) : undefined,
  ]);
}

/** `week#2026-11-09` of a period record id `week#2026-11-09#<id>`; null for a record made before periods existed. */
export function periodKeyOf(id: string): string | null {
  const parts = String(id).split('#');
  return parts.length >= 3 ? `${parts[0]}#${parts[1]}` : null;
}

const idTail = (id: string): string => String(id).split('#').pop() as string;

/**
 * A period copy keeps the dates of the record it copies: a copy made when Goals opens is not a rule the user set.
 * The first-run checklist (TradeFlow useGettingStarted) reads these dates to tell starter records from the user's own.
 */
function copyStamps(src: { createdAt?: unknown; updatedAt?: unknown }, now: string): { createdAt: string; updatedAt: string } {
  const createdAt = typeof src.createdAt === 'string' ? src.createdAt : now;
  return { createdAt, updatedAt: typeof src.updatedAt === 'string' ? src.updatedAt : createdAt };
}

function cloneRules(sourceRules: any[], userId: string, periodKey: string): any[] {
  const now = new Date().toISOString();
  return sourceRules.map(rule => ({
    ...rule,
    userId,
    ruleId: `${periodKey}#${idTail(rule.ruleId)}`,
    completed: false,
    ...copyStamps(rule, now),
  }));
}

/** Only the goals of the period's own kind are carried over: a weekly goal is not a monthly one. */
function cloneGoals(sourceGoals: any[], userId: string, periodKey: string): any[] {
  const now = new Date().toISOString();
  const periodType = getPeriodType(periodKey);
  return sourceGoals.filter(goal => goal.period === periodType).map(goal => ({
    ...goal,
    userId,
    goalId: `${periodKey}#${idTail(goal.goalId)}`,
    ...copyStamps(goal, now),
  }));
}

// Export helpers for testing
export { getPreviousPeriodKey, getPeriodType, isLegacyRecord, createDefaultRules, createDefaultGoals, periodHoldsDay };
