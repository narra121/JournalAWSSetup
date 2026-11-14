import { QueryCommand } from '@aws-sdk/lib-dynamodb';
import { ddb } from './dynamo';
import type { DailyStatsRecord } from './metrics/types';

/**
 * Day records of one account (`accountId`) or of every account (`'ALL'`) between two local days, all pages.
 * One account reads the main table by sort key (`<accountId>#<date>`), ALL reads `stats-by-date-gsi`.
 * `projection` limits the attributes read (it may use the `#date` and `#sk` placeholders).
 */
export async function queryDailyStats(
  userId: string,
  accountId: string,
  startDate: string,
  endDate: string,
  projection?: string,
): Promise<DailyStatsRecord[]> {
  const isAll = accountId === 'ALL';
  const records: DailyStatsRecord[] = [];
  let exclusiveStartKey: Record<string, any> | undefined;
  do {
    const result = await ddb.send(new QueryCommand({
      TableName: process.env.DAILY_STATS_TABLE!,
      ...(isAll ? { IndexName: 'stats-by-date-gsi' } : {}),
      KeyConditionExpression: isAll ? 'userId = :userId AND #date BETWEEN :startDate AND :endDate' : 'userId = :userId AND #sk BETWEEN :skStart AND :skEnd',
      ...(projection ? { ProjectionExpression: projection } : {}),
      ExpressionAttributeNames: projection ? { '#date': 'date', '#sk': 'sk' } : isAll ? { '#date': 'date' } : { '#sk': 'sk' },
      ExpressionAttributeValues: isAll
        ? { ':userId': userId, ':startDate': startDate, ':endDate': endDate }
        : { ':userId': userId, ':skStart': `${accountId}#${startDate}`, ':skEnd': `${accountId}#${endDate}` },
      ExclusiveStartKey: exclusiveStartKey,
    }));
    if (result.Items) records.push(...(result.Items as DailyStatsRecord[]));
    exclusiveStartKey = result.LastEvaluatedKey;
  } while (exclusiveStartKey);
  return records;
}

/** Trade count and latest trade day of one account, summed from all its day records. */
export async function accountTally(userId: string, accountId: string): Promise<{ tradeCount: number; lastTradeDate: string | null }> {
  const days = await queryDailyStats(userId, accountId, '0000-01-01', '9999-12-31', '#date, tradeCount');
  let tradeCount = 0;
  let lastTradeDate: string | null = null;
  for (const day of days) {
    if (!(day.tradeCount > 0)) continue;
    tradeCount += day.tradeCount;
    if (!lastTradeDate || day.date > lastTradeDate) lastTradeDate = day.date;
  }
  return { tradeCount, lastTradeDate };
}

/** Latest day with trades of one account (its newest day record), or null. */
export async function latestTradeDay(userId: string, accountId: string): Promise<string | null> {
  const result = await ddb.send(new QueryCommand({
    TableName: process.env.DAILY_STATS_TABLE!,
    KeyConditionExpression: 'userId = :userId AND #sk BETWEEN :skStart AND :skEnd',
    ProjectionExpression: '#date',
    ExpressionAttributeNames: { '#sk': 'sk', '#date': 'date' },
    ExpressionAttributeValues: { ':userId': userId, ':skStart': `${accountId}#0000-01-01`, ':skEnd': `${accountId}#9999-12-31` },
    ScanIndexForward: false,
    Limit: 1,
  }));
  return result.Items?.[0]?.date ?? null;
}
