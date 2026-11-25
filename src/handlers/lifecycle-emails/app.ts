import { GetCommand, QueryCommand, ScanCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { computeEntitlements } from '../../app/billing/entitlements';
import { createQuota } from '../../app/billing/quota';
import { ddb } from '../../shared/dynamo';
import {
  firstTradesMail,
  getUserEmail,
  otherWaysMail,
  sendEmail,
  tagTradesMail,
  trialEndedMail,
  trialEndingMail,
  weekReviewMail,
  weeklyReportMail,
  type Mail,
} from '../../shared/email';

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

/** True when the user has at least one trade that is not soft-deleted. */
async function hasTrades(userId: string): Promise<boolean> {
  let lastKey: Record<string, any> | undefined;
  do {
    // No Limit: DynamoDB applies it before the filter, so a first page of deleted trades would read as "none".
    const res = await ddb.send(
      new QueryCommand({
        TableName: process.env.TRADES_TABLE!,
        KeyConditionExpression: 'userId = :u',
        FilterExpression: 'attribute_not_exists(deletedAt)',
        ExpressionAttributeValues: { ':u': userId },
        Select: 'COUNT',
        ExclusiveStartKey: lastKey,
      }),
    );
    if ((res.Count ?? 0) > 0) return true;
    lastKey = res.LastEvaluatedKey;
  } while (lastKey);
  return false;
}

/** The getting-started mail for each full day since sign-up; `null` where that user needs none. */
const GETTING_STARTED: { day: number; marker: string; mail: (traded: boolean) => ((to: string) => Mail) | null }[] = [
  { day: 1, marker: 'gettingStartedDay1For', mail: (traded) => (traded ? null : firstTradesMail) },
  { day: 3, marker: 'gettingStartedDay3For', mail: (traded) => (traded ? tagTradesMail : otherWaysMail) },
  { day: 7, marker: 'gettingStartedDay7For', mail: (traded) => (traded ? weekReviewMail : null) },
];

/** Sends the getting-started mail due today, unless the user switched these mails off; true when one was sent. */
async function sendGettingStarted(sub: Record<string, any>, now: Date): Promise<boolean> {
  // `trialStarted` is written only when an account is confirmed (auth-post-confirmation). A trial granted again by
  // billing/middleware.ts sets `trialGrantedAt` instead, so a returning older user is never in these windows.
  const started = new Date(sub.trialStarted ?? '').getTime();
  if (Number.isNaN(started)) return false;
  const age = now.getTime() - started;
  const due = GETTING_STARTED.find((g) => age >= g.day * DAY && age < (g.day + 1) * DAY);
  if (!due) return false;
  const prefs = (await ddb.send(new GetCommand({ TableName: process.env.USER_PREFERENCES_TABLE!, Key: { userId: sub.userId } }))).Item;
  if (prefs?.notifications?.tradeReminders === false) return false;
  const build = due.mail(await hasTrades(sub.userId));
  if (!build || !(await claim(sub.userId, due.marker, sub.trialStarted))) return false;
  return mailUser(sub.userId, build);
}

export interface LifecycleResult {
  trialEnding: number;
  trialEnded: number;
  gettingStarted: number;
  failed: number;
}

/**
 * Daily job. Trial users get one mail three days before the trial ends and one when it has ended (each at most once per
 * trial end date). Both are transactional notices and are always sent. In the first week they also get up to three
 * getting-started mails, which Settings → Notifications switches off.
 */
export async function runLifecycleEmails(now: Date = new Date()): Promise<LifecycleResult> {
  const result: LifecycleResult = { trialEnding: 0, trialEnded: 0, gettingStarted: 0, failed: 0 };
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
      if (await sendGettingStarted(sub, now)) result.gettingStarted++;
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
  /** the 7 days before today in the user's zone, and the currencies with at least 5 trades in them */
  plan: (userId: string, now: Date) => Promise<{ from: string; to: string; currencies: string[] }>;
  generate: (userId: string, entitlements: ReturnType<typeof computeEntitlements>, input: { from: string; to: string; currency: string }) => Promise<{ ok: boolean; cached?: boolean; summary?: string }>;
}

export interface WeeklyResult {
  /** reports generated and mailed (one per currency) */
  generated: number;
  /** users opted out, and reports cached or not generated */
  skipped: number;
  failed: number;
}

/**
 * Weekly job for Pro and trial users who have the weekly report switched on (default on): one report per currency the
 * user traded at least 5 times in the last 7 days, each judged against its 90-day baseline, and one "report ready"
 * mail per new report. A cached report (nothing new) sends nothing.
 */
export async function runWeeklyReports(deps: WeeklyDeps, now: Date = new Date()): Promise<WeeklyResult> {
  const result: WeeklyResult = { generated: 0, skipped: 0, failed: 0 };
  await forEachLimited(await scanSubscriptions(), WEEKLY_CONCURRENCY, async (sub) => {
    const entitlements = computeEntitlements(sub, now);
    if (entitlements.plan === 'free') return;
    const failed = (err: any, currency?: string) => {
      result.failed++;
      console.error(JSON.stringify({ msg: 'weekly_report_failed', userId: sub.userId, ...(currency ? { currency } : {}), error: err.message }));
    };
    let plan: Awaited<ReturnType<WeeklyDeps['plan']>>;
    try {
      const prefs = (await ddb.send(new GetCommand({ TableName: process.env.USER_PREFERENCES_TABLE!, Key: { userId: sub.userId } }))).Item;
      if (prefs?.notifications?.weeklyReport === false) {
        result.skipped++;
        return;
      }
      plan = await deps.plan(sub.userId, now);
    } catch (err: any) {
      return failed(err);
    }
    // One currency failing does not stop the user's other reports.
    for (const currency of plan.currencies) {
      try {
        const res = await deps.generate(sub.userId, entitlements, { from: plan.from, to: plan.to, currency });
        if (!res.ok || res.cached) {
          result.skipped++;
          continue;
        }
        if (await mailUser(sub.userId, (addr) => weeklyReportMail(addr, res.summary ?? 'Your latest insights are ready.'))) result.generated++;
      } catch (err: any) {
        failed(err, currency);
      }
    }
  });
  return result;
}

/** Wiring used by the Event Function: features' insight generator with the user's own quota. */
export async function defaultWeeklyDeps(): Promise<WeeklyDeps> {
  const { generateInsight, weeklyPlan } = await import('../../features/insights/service');
  const { defaultInsightDeps } = await import('../../features/insights/routes');
  return {
    plan: (userId, now) => weeklyPlan(defaultInsightDeps, userId, now),
    generate: async (userId, entitlements, input) => {
      const res = await generateInsight(defaultInsightDeps, createQuota(userId, entitlements), userId, { accountId: null, ...input });
      return res.ok ? { ok: true, cached: res.cached, summary: res.insight.summary } : { ok: false };
    },
  };
}
