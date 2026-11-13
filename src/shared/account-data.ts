import { CognitoIdentityProviderClient, AdminDeleteUserCommand } from '@aws-sdk/client-cognito-identity-provider';
import { DeleteObjectsCommand, ListObjectsV2Command, S3Client } from '@aws-sdk/client-s3';
import { DeleteCommand, GetCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { batchWriteDeleteAll } from './batchWrite';
import { resolveCognitoUsername } from './cognitoUser';
import { ddb } from './dynamo';
import type { Logger } from './logger';
import { getStripe } from './stripe-config';

const cognito = new CognitoIdentityProviderClient({});
const s3 = new S3Client({});

/** Tables with a (userId, <sort key>) primary key, in the order they are read and purged. */
function sortKeyTables() {
  return [
    { name: 'trades', table: process.env.TRADES_TABLE!, sortKey: 'tradeId' },
    { name: 'accounts', table: process.env.ACCOUNTS_TABLE!, sortKey: 'accountId' },
    { name: 'goals', table: process.env.GOALS_TABLE!, sortKey: 'goalId' },
    { name: 'rules', table: process.env.RULES_TABLE!, sortKey: 'ruleId' },
    { name: 'stats', table: process.env.DAILY_STATS_TABLE!, sortKey: 'sk' },
    { name: 'aiData', table: process.env.AI_DATA_TABLE!, sortKey: 'sk' },
    { name: 'usage', table: process.env.USAGE_TABLE!, sortKey: 'sk' },
  ];
}

/** Tables keyed by userId alone. */
function singleItemTables() {
  return [
    { name: 'subscription', table: process.env.SUBSCRIPTIONS_TABLE! },
    { name: 'preferences', table: process.env.USER_PREFERENCES_TABLE! },
    { name: 'savedOptions', table: process.env.SAVED_OPTIONS_TABLE! },
  ];
}

async function queryAll(table: string, userId: string, projection?: string): Promise<Record<string, any>[]> {
  const items: Record<string, any>[] = [];
  let lastKey: Record<string, any> | undefined;
  do {
    const res = await ddb.send(
      new QueryCommand({
        TableName: table,
        KeyConditionExpression: 'userId = :u',
        ExpressionAttributeValues: { ':u': userId },
        ...(projection ? { ProjectionExpression: projection.split(',').map((p) => `#${p.trim()}`).join(', '), ExpressionAttributeNames: Object.fromEntries(projection.split(',').map((p) => [`#${p.trim()}`, p.trim()])) } : {}),
        ExclusiveStartKey: lastKey,
      }),
    );
    items.push(...(res.Items ?? []));
    lastKey = res.LastEvaluatedKey;
  } while (lastKey);
  return items;
}

async function listKeys(bucket: string, prefix: string): Promise<string[]> {
  const keys: string[] = [];
  let token: string | undefined;
  do {
    const res = await s3.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, ContinuationToken: token }));
    for (const o of res.Contents ?? []) if (o.Key) keys.push(o.Key);
    token = res.IsTruncated ? res.NextContinuationToken : undefined;
  } while (token);
  return keys;
}

async function deleteKeys(bucket: string, keys: string[]): Promise<void> {
  for (let i = 0; i < keys.length; i += 1000) {
    await s3.send(
      new DeleteObjectsCommand({ Bucket: bucket, Delete: { Objects: keys.slice(i, i + 1000).map((Key) => ({ Key })), Quiet: true } }),
    );
  }
}

export interface UserExport {
  exportVersion: 1;
  exportedAt: string;
  profile: { userId: string; email?: string };
  accounts: any[];
  trades: any[];
  goals: any[];
  rules: any[];
  preferences: any;
  savedOptions: any;
  subscription: { status?: string; planId?: string; currentStart?: string; currentEnd?: string; trialEnd?: string } | null;
  aiData: any[];
}

/** Everything the user owns, as one JSON document. Billing identifiers and payment details are not included. */
export async function exportUserData(userId: string, email?: string): Promise<UserExport> {
  const [accounts, trades, goals, rules, aiData] = await Promise.all([
    queryAll(process.env.ACCOUNTS_TABLE!, userId),
    queryAll(process.env.TRADES_TABLE!, userId).then((items) => items.filter((t) => !t.deletedAt)),
    queryAll(process.env.GOALS_TABLE!, userId),
    queryAll(process.env.RULES_TABLE!, userId),
    queryAll(process.env.AI_DATA_TABLE!, userId),
  ]);
  const get = async (table: string) => (await ddb.send(new GetCommand({ TableName: table, Key: { userId } }))).Item ?? null;
  const [preferences, savedOptions, sub] = await Promise.all([
    get(process.env.USER_PREFERENCES_TABLE!),
    get(process.env.SAVED_OPTIONS_TABLE!),
    get(process.env.SUBSCRIPTIONS_TABLE!),
  ]);
  return {
    exportVersion: 1,
    exportedAt: new Date().toISOString(),
    profile: { userId, ...(email ? { email } : {}) },
    accounts,
    trades,
    goals,
    rules,
    preferences,
    savedOptions,
    subscription: sub
      ? { status: sub.status, planId: sub.planId, currentStart: sub.currentStart, currentEnd: sub.currentEnd, trialEnd: sub.trialEnd }
      : null,
    aiData,
  };
}

/** Report keys are `errors/<userId>/<date>/...`; the 365-day retention of the older `errors/<date>/<userId>/` layout bounds this sweep. */
const LEGACY_REPORT_DAYS = 366;

async function legacyReportKeys(bucket: string, userId: string): Promise<string[]> {
  const days = Array.from({ length: LEGACY_REPORT_DAYS }, (_, i) => new Date(Date.now() - i * 86_400_000).toISOString().slice(0, 10));
  const keys: string[] = [];
  for (let i = 0; i < days.length; i += 25) {
    const batch = await Promise.all(days.slice(i, i + 25).map((day) => listKeys(bucket, `errors/${day}/${userId}/`)));
    keys.push(...batch.flat());
  }
  return keys;
}

const stripeMissing = (err: any) => err?.code === 'resource_missing' || /No such (subscription|customer)/i.test(err?.message ?? '');

export interface PurgeResult {
  deleted: Record<string, number>;
  images: number;
  errorReports: number;
  stripeSubscriptionCancelled: boolean;
}

/**
 * Deletes everything held for a user: cancels the Stripe subscription and deletes the Stripe customer, removes every
 * table item, the screenshots and the error reports, and deletes the Cognito user last, so a failed run can be repeated
 * by the same signed-in user. Pass the caller's `claims` when `userId` is the signed-in user (see resolveCognitoUsername).
 */
export async function purgeUser(userId: string, log?: Logger, claims?: Record<string, unknown>): Promise<PurgeResult> {
  // Resolved first so a lookup failure cannot leave a half-purged account; a user missing from the pool has nothing to delete there.
  const username = await resolveCognitoUsername(process.env.USER_POOL_ID!, userId, claims).catch((err) => {
    if (err?.name === 'UserNotFoundException') return null;
    throw err;
  });

  let stripeSubscriptionCancelled = false;
  const sub = (await ddb.send(new GetCommand({ TableName: process.env.SUBSCRIPTIONS_TABLE!, Key: { userId } }))).Item;
  if (sub?.stripeSubscriptionId) {
    try {
      await (await getStripe()).subscriptions.cancel(sub.stripeSubscriptionId);
      stripeSubscriptionCancelled = true;
    } catch (err: any) {
      // An already-cancelled or missing subscription is fine; anything else stops the purge before data is removed.
      if (!stripeMissing(err)) throw err;
    }
  }
  if (sub?.stripeCustomerId) {
    try {
      await (await getStripe()).customers.del(sub.stripeCustomerId);
    } catch (err: any) {
      if (!stripeMissing(err)) throw err;
    }
  }

  const deleted: Record<string, number> = {};
  for (const { name, table, sortKey } of sortKeyTables()) {
    const keys = await queryAll(table, userId, `userId,${sortKey}`);
    await batchWriteDeleteAll({ ddb, tableName: table, keys, log });
    deleted[name] = keys.length;
  }
  for (const { name, table } of singleItemTables()) {
    await ddb.send(new DeleteCommand({ TableName: table, Key: { userId } }));
    deleted[name] = 1;
  }

  const imageKeys = await listKeys(process.env.IMAGES_BUCKET!, `images/${userId}/`);
  await deleteKeys(process.env.IMAGES_BUCKET!, imageKeys);
  const reportBucket = process.env.ERROR_REPORTS_BUCKET;
  const reportKeys = reportBucket
    ? [...(await listKeys(reportBucket, `errors/${userId}/`)), ...(await legacyReportKeys(reportBucket, userId))]
    : [];
  if (reportBucket) await deleteKeys(reportBucket, reportKeys);

  if (username) await cognito.send(new AdminDeleteUserCommand({ UserPoolId: process.env.USER_POOL_ID!, Username: username }));
  return { deleted, images: imageKeys.length, errorReports: reportKeys.length, stripeSubscriptionCancelled };
}
