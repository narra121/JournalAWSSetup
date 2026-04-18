import { GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import { ddb } from '../dynamo';
import type { InsightsResponse } from './validation';

const INSIGHTS_CACHE_TABLE = process.env.INSIGHTS_CACHE_TABLE!;

// ---- Constants ----

export const CACHE_TTL_DAYS = 30;
export const MIN_TRADES_THRESHOLD = 10;

// ---- Types ----

export interface CacheRecord {
  userId: string;
  cacheKey: string;
  response: string; // JSON-serialized InsightsResponse
  generatedAt: string;
  stale: boolean;
  ttl: number;
}

// ---- Cache Key ----

export function buildCacheKey(accountId: string | undefined, startDate: string, endDate: string): string {
  return `${accountId || 'all'}#${startDate}#${endDate}`;
}

/**
 * Parse a cache key back into its components.
 * Returns [accountId, startDate, endDate] where accountId is 'all' when no specific account.
 */
export function parseCacheKey(cacheKey: string): [string, string, string] {
  const parts = cacheKey.split('#');
  return [parts[0], parts[1], parts[2]];
}

// ---- Cache Operations ----

export async function getCacheEntry(userId: string, cacheKey: string): Promise<CacheRecord | null> {
  const result = await ddb.send(new GetCommand({
    TableName: INSIGHTS_CACHE_TABLE,
    Key: { userId, cacheKey },
  }));
  return (result.Item as CacheRecord | undefined) ?? null;
}

export async function writeCacheEntry(
  userId: string,
  cacheKey: string,
  response: InsightsResponse,
  generatedAt: string,
): Promise<void> {
  const ttl = Math.floor(Date.now() / 1000) + CACHE_TTL_DAYS * 24 * 60 * 60;
  await ddb.send(new PutCommand({
    TableName: INSIGHTS_CACHE_TABLE,
    Item: {
      userId,
      cacheKey,
      response: JSON.stringify(response),
      generatedAt,
      stale: false,
      ttl,
    },
  }));
}
