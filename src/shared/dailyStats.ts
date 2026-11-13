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
