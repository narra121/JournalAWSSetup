import { GetCommand, ScanCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { computeEntitlements } from '../../app/billing/entitlements';
import { createQuota } from '../../app/billing/quota';
import { ddb } from '../../shared/dynamo';
import { getUserEmail, sendEmail, trialEndedMail, trialEndingMail, weeklyReportMail, type Mail } from '../../shared/email';

const DAY = 86_400_000;

async function scanSubscriptions(): Promise<Record<string, any>[]> {
  const items: Record<string, any>[] = [];
  let lastKey: Record<string, any> | undefined;
  do {
    const res = await ddb.send(new ScanCommand({ TableName: process.env.SUBSCRIPTIONS_TABLE!, ExclusiveStartKey: lastKey }));
    items.push(...(res.Items ?? []));
    lastKey = res.LastEvaluatedKey;
  } while (lastKey);
  return items;
}

/** Records that a mail was sent; false when this marker is already set, so a rerun never sends twice. */
async function claim(userId: string, marker: string, value: string): Promise<boolean> {
  try {
    await ddb.send(
      new UpdateCommand({
        TableName: process.env.SUBSCRIPTIONS_TABLE!,
        Key: { userId },
        UpdateExpression: 'SET #m = :v',
        ConditionExpression: 'attribute_not_exists(#m) OR #m <> :v',
        ExpressionAttributeNames: { '#m': marker },
        ExpressionAttributeValues: { ':v': value },
      }),
    );
    return true;
  } catch (err: any) {
    if (err.name === 'ConditionalCheckFailedException') return false;
    throw err;
  }
}

async function mailUser(userId: string, build: (to: string) => Mail): Promise<boolean> {
  const to = await getUserEmail(userId);
  if (!to) return false;
  await sendEmail(build(to));
  return true;
}

export interface LifecycleResult {
  trialEnding: number;
  trialEnded: number;
  failed: number;
}

/**
 * Daily job. Trial users get one mail three days before the trial ends and one when it has ended (each at most once per
 * trial end date). Both are transactional notices and are always sent.
 */
export async function runLifecycleEmails(now: Date = new Date()): Promise<LifecycleResult> {
  const result: LifecycleResult = { trialEnding: 0, trialEnded: 0, failed: 0 };
  for (const sub of await scanSubscriptions()) {
    if (sub.status !== 'trial' || !sub.trialEnd) continue;
    const end = new Date(sub.trialEnd).getTime();
    if (Number.isNaN(end)) continue;
    const msLeft = end - now.getTime();
    try {
      if (msLeft > 2 * DAY && msLeft <= 3 * DAY) {
        if (await claim(sub.userId, 'trialEndingEmailFor', sub.trialEnd)) {
          if (await mailUser(sub.userId, (to) => trialEndingMail(to, sub.trialEnd.slice(0, 10)))) result.trialEnding++;
        }
      } else if (msLeft <= 0 && msLeft > -2 * DAY) {
        if (await claim(sub.userId, 'trialEndedEmailFor', sub.trialEnd)) {
          if (await mailUser(sub.userId, (to) => trialEndedMail(to))) result.trialEnded++;
        }
      }
    } catch (err: any) {
      result.failed++;
      console.error(JSON.stringify({ msg: 'lifecycle_email_failed', userId: sub.userId, error: err.message }));
    }
  }
  return result;
}

/** Insight generation is ~10 s per user; serial runs of 60+ users hit the Event Function's 600 s timeout and starve the later users. */
const WEEKLY_CONCURRENCY = 8;

/** Runs `fn` over `items` with at most `limit` in flight, starting them in list order. */
async function forEachLimited<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) await fn(items[next++]);
    }),
  );
}

export interface WeeklyDeps {
  generate: (userId: string, entitlements: ReturnType<typeof computeEntitlements>, range: { from: string; to: string }) => Promise<{ ok: boolean; cached?: boolean; summary?: string }>;
}

export interface WeeklyResult {
  generated: number;
  skipped: number;
  failed: number;
}

/**
 * Weekly job for Pro and trial users who have the weekly report switched on (default on): generates the insight for
 * the last 7 days and sends the "report ready" mail. A cached insight (nothing new) sends nothing.
 */
export async function runWeeklyReports(deps: WeeklyDeps, now: Date = new Date()): Promise<WeeklyResult> {
  const result: WeeklyResult = { generated: 0, skipped: 0, failed: 0 };
  const to = new Date(now.getTime() - DAY).toISOString().slice(0, 10);
  const from = new Date(now.getTime() - 7 * DAY).toISOString().slice(0, 10);
  await forEachLimited(await scanSubscriptions(), WEEKLY_CONCURRENCY, async (sub) => {
    const entitlements = computeEntitlements(sub, now);
    if (entitlements.plan === 'free') return;
    try {
      const prefs = (await ddb.send(new GetCommand({ TableName: process.env.USER_PREFERENCES_TABLE!, Key: { userId: sub.userId } }))).Item;
      if (prefs?.notifications?.weeklyReport === false) {
        result.skipped++;
        return;
      }
      const res = await deps.generate(sub.userId, entitlements, { from, to });
      if (!res.ok || res.cached) {
        result.skipped++;
        return;
      }
      if (await mailUser(sub.userId, (addr) => weeklyReportMail(addr, res.summary ?? 'Your latest insights are ready.'))) result.generated++;
    } catch (err: any) {
      result.failed++;
      console.error(JSON.stringify({ msg: 'weekly_report_failed', userId: sub.userId, error: err.message }));
    }
  });
  return result;
}

/** Wiring used by the Event Function: features' insight generator with the user's own quota. */
export async function defaultWeeklyDeps(): Promise<WeeklyDeps> {
  const { generateInsight, defaultInsightDeps } = await import('../../features/index');
  return {
    generate: async (userId, entitlements, range) => {
      const res = await generateInsight(defaultInsightDeps, createQuota(userId, entitlements), userId, { accountId: null, ...range });
      return res.ok ? { ok: true, cached: res.cached, summary: res.insight.summary } : { ok: false };
    },
  };
}
