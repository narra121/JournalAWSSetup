import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import { QueryCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { ddb } from '../../shared/dynamo';
import type { Entitlements, Quota, QuotaFeature } from '../types';
import { QUOTA_FEATURES } from './entitlements';

const TTL_SECONDS = 400 * 24 * 3600;

export function currentPeriod(now: Date = new Date()): string {
  return now.toISOString().slice(0, 7);
}

/** First instant of the next UTC month, when every monthly counter starts again. */
export function periodResetsAt(now: Date = new Date()): string {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)).toISOString();
}

const usageTable = () => process.env.USAGE_TABLE!;

/**
 * Atomic monthly counters in the Usage table (`sk = <YYYY-MM>#<feature>`).
 * `n < 0` refunds a unit with no condition; a `null` limit counts without capping.
 */
export function createQuota(userId: string, entitlements: Entitlements, now: () => Date = () => new Date()): Quota {
  return {
    async consume(feature: QuotaFeature, n = 1) {
      const at = now();
      const limit = entitlements.limits[feature];
      const values: Record<string, unknown> = {
        ':n': n,
        ':ttl': Math.floor(at.getTime() / 1000) + TTL_SECONDS,
      };
      const input = {
        TableName: usageTable(),
        Key: { userId, sk: `${currentPeriod(at)}#${feature}` },
        UpdateExpression: 'ADD #c :n SET #t = :ttl',
        ExpressionAttributeNames: { '#c': 'count', '#t': 'ttl' },
        ExpressionAttributeValues: values,
        ReturnValues: 'ALL_NEW' as const,
      };
      try {
        if (n > 0 && limit !== null) {
          values[':max'] = limit - n;
          const res = await ddb.send(
            new UpdateCommand({ ...input, ConditionExpression: 'attribute_not_exists(#c) OR #c <= :max' }),
          );
          return { ok: true as const, remaining: limit - Number(res.Attributes?.count ?? n) };
        }
        const res = await ddb.send(new UpdateCommand(input));
        return { ok: true as const, remaining: limit === null ? null : limit - Number(res.Attributes?.count ?? 0) };
      } catch (err) {
        if (err instanceof ConditionalCheckFailedException || (err as any)?.name === 'ConditionalCheckFailedException') {
          return { ok: false as const, limit: limit as number, resetsAt: periodResetsAt(at) };
        }
        throw err;
      }
    },
  };
}

export async function readUsage(userId: string, now: Date = new Date()): Promise<Record<QuotaFeature, number>> {
  const usage = Object.fromEntries(QUOTA_FEATURES.map((f) => [f, 0])) as Record<QuotaFeature, number>;
  const res = await ddb.send(
    new QueryCommand({
      TableName: usageTable(),
      KeyConditionExpression: 'userId = :u AND begins_with(sk, :p)',
      ExpressionAttributeValues: { ':u': userId, ':p': `${currentPeriod(now)}#` },
    }),
  );
  for (const item of res.Items ?? []) {
    const feature = String(item.sk).split('#')[1] as QuotaFeature;
    if (feature in usage) usage[feature] = Math.max(0, Number(item.count) || 0);
  }
  return usage;
}
