import { ddb } from './dynamo';
import { QueryCommand, PutCommand, DeleteCommand } from '@aws-sdk/lib-dynamodb';
import { computeMonthHash } from './stats-aggregator';

const DAILY_STATS_TABLE = process.env.DAILY_STATS_TABLE!;

/**
 * Recompute monthly batch hashes for the given (userId, accountId, months).
 *
 * For each month, queries all daily records in that month, computes a batch
 * hash (SHA-256 of sorted day hashes), and writes/deletes the monthly hash
 * record in DailyStats table with SK format: {accountId}#MONTH#{YYYY-MM}.
 */
export async function recomputeMonthlyHashes(
  userId: string,
  accountId: string,
  months: Set<string>,
): Promise<void> {
  for (const month of months) {
    const startDate = `${month}-01`;
    const endDate = `${month}-31`;

    const result = await ddb.send(new QueryCommand({
      TableName: DAILY_STATS_TABLE,
      KeyConditionExpression: 'userId = :userId AND sk BETWEEN :skStart AND :skEnd',
      ExpressionAttributeValues: {
        ':userId': userId,
        ':skStart': `${accountId}#${startDate}`,
        ':skEnd': `${accountId}#${endDate}`,
      },
      ProjectionExpression: '#d, tradeHash',
      ExpressionAttributeNames: { '#d': 'date' },
    }));

    const records = (result.Items || []).filter(
      (item: any) => item.tradeHash && item.date
    );

    const monthSk = `${accountId}#MONTH#${month}`;

    if (records.length === 0) {
      await ddb.send(new DeleteCommand({
        TableName: DAILY_STATS_TABLE,
        Key: { userId, sk: monthSk },
      }));
    } else {
      const dayHashes = records.map((r: any) => ({
        date: r.date as string,
        tradeHash: r.tradeHash as string,
      }));
      const monthHash = computeMonthHash(dayHashes);

      await ddb.send(new PutCommand({
        TableName: DAILY_STATS_TABLE,
        Item: {
          userId,
          sk: monthSk,
          accountId,
          month,
          monthHash,
          lastUpdated: new Date().toISOString(),
        },
      }));
    }
  }
}
