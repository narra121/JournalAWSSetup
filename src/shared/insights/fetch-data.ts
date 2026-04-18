import { QueryCommand, BatchGetCommand } from '@aws-sdk/lib-dynamodb';
import { ddb } from '../dynamo';
import { aggregateDailyRecords } from '../stats-aggregator';
import { DailyStatsRecord, AggregatedStats } from '../metrics/types';

const TRADES_TABLE = process.env.TRADES_TABLE!;
const DAILY_STATS_TABLE = process.env.DAILY_STATS_TABLE!;

// ---- Trade Fetching ----

/**
 * Query trades from the trades-by-date-gsi (KEYS_ONLY), then BatchGet full records.
 * Returns all trades for the user within the date range, optionally filtered by accountId.
 * No pagination limit -- fetches all trades in the range for AI analysis.
 */
export async function fetchTrades(
  userId: string,
  startDate: string,
  endDate: string,
  accountId?: string,
): Promise<any[]> {
  const inclusiveEnd = endDate.length === 10 ? endDate + 'T23:59:59.999Z' : endDate;

  // Step 1: Query GSI for keys
  const allKeys: Array<{ userId: string; tradeId: string }> = [];
  let exclusiveStartKey: Record<string, any> | undefined;

  do {
    const result = await ddb.send(
      new QueryCommand({
        TableName: TRADES_TABLE,
        IndexName: 'trades-by-date-gsi',
        KeyConditionExpression: 'userId = :u AND #od BETWEEN :start AND :end',
        ExpressionAttributeValues: { ':u': userId, ':start': startDate, ':end': inclusiveEnd },
        ExpressionAttributeNames: { '#od': 'openDate' },
        ExclusiveStartKey: exclusiveStartKey,
      }),
    );
    if (result.Items) {
      allKeys.push(...result.Items.map((it: any) => ({ userId: it.userId, tradeId: it.tradeId })));
    }
    exclusiveStartKey = result.LastEvaluatedKey;
  } while (exclusiveStartKey);

  if (allKeys.length === 0) return [];

  // Step 2: BatchGet full records in parallel chunks of 100
  const chunks: Array<Array<{ userId: string; tradeId: string }>> = [];
  for (let i = 0; i < allKeys.length; i += 100) {
    chunks.push(allKeys.slice(i, i + 100));
  }

  const batchResults = await Promise.all(
    chunks.map(chunk =>
      ddb.send(new BatchGetCommand({
        RequestItems: { [TRADES_TABLE]: { Keys: chunk } },
      })),
    ),
  );

  const fullItems: any[] = [];
  const unprocessedKeys: Array<Array<Record<string, any>>> = [];

  for (const batchResult of batchResults) {
    if (batchResult.Responses?.[TRADES_TABLE]) {
      fullItems.push(...batchResult.Responses[TRADES_TABLE]);
    }
    if (batchResult.UnprocessedKeys?.[TRADES_TABLE]?.Keys?.length) {
      unprocessedKeys.push(batchResult.UnprocessedKeys[TRADES_TABLE].Keys as Array<Record<string, any>>);
    }
  }

  // Retry unprocessed keys with backoff
  for (const retryKeys of unprocessedKeys) {
    let keysToRetry = retryKeys;
    let attempt = 0;
    while (keysToRetry.length > 0 && attempt < 3) {
      if (attempt > 0) {
        await new Promise(resolve => setTimeout(resolve, 50 * Math.pow(2, attempt)));
      }
      const retryResult = await ddb.send(new BatchGetCommand({
        RequestItems: { [TRADES_TABLE]: { Keys: keysToRetry } },
      }));
      if (retryResult.Responses?.[TRADES_TABLE]) {
        fullItems.push(...retryResult.Responses[TRADES_TABLE]);
      }
      keysToRetry = (retryResult.UnprocessedKeys?.[TRADES_TABLE]?.Keys as Array<Record<string, any>> | undefined) || [];
      attempt++;
    }
  }

  // Filter by accountId if specified
  if (accountId) {
    return fullItems.filter((it: any) => it.accountId === accountId);
  }

  return fullItems;
}

// ---- Stats Fetching ----

/**
 * Fetch DailyStats records and aggregate them.
 * Follows the same pattern as get-stats handler.
 */
export async function fetchAggregatedStats(
  userId: string,
  startDate: string,
  endDate: string,
  accountId?: string,
): Promise<AggregatedStats> {
  const records = accountId
    ? await queryDailyStatsSingleAccount(userId, accountId, startDate, endDate)
    : await queryDailyStatsAllAccounts(userId, startDate, endDate);

  return aggregateDailyRecords(records);
}

export async function queryDailyStatsAllAccounts(
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

export async function queryDailyStatsSingleAccount(
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

// ---- Count Trades Since ----

/**
 * Count trades created after a given timestamp to populate meta.newTradesSince.
 * Uses the trades-by-date-gsi to count trades with openDate > generatedAt.
 */
export async function countTradesSince(
  userId: string,
  sinceTimestamp: string,
  endDate: string,
  accountId?: string,
): Promise<number> {
  let count = 0;
  let exclusiveStartKey: Record<string, any> | undefined;

  do {
    const result = await ddb.send(
      new QueryCommand({
        TableName: TRADES_TABLE,
        IndexName: 'trades-by-date-gsi',
        KeyConditionExpression: 'userId = :u AND #od BETWEEN :start AND :end',
        ExpressionAttributeValues: { ':u': userId, ':start': sinceTimestamp, ':end': endDate + 'T23:59:59.999Z' },
        ExpressionAttributeNames: { '#od': 'openDate' },
        Select: 'COUNT',
        ExclusiveStartKey: exclusiveStartKey,
      }),
    );
    count += result.Count || 0;
    exclusiveStartKey = result.LastEvaluatedKey;
  } while (exclusiveStartKey);

  return count;
}
