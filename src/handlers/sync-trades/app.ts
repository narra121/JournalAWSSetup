import { APIGatewayProxyHandlerV2 } from 'aws-lambda';
import { QueryCommand, BatchGetCommand } from '@aws-sdk/lib-dynamodb';
import { ddb } from '../../shared/dynamo';
import { getUserId } from '../../shared/auth';
import { envelope, errorResponse, ErrorCodes } from '../../shared/validation';
import { DailyStatsRecord } from '../../shared/metrics/types';
import { createHash } from 'crypto';

const DAILY_STATS_TABLE = process.env.DAILY_STATS_TABLE!;
const TRADES_TABLE = process.env.TRADES_TABLE!;

interface SyncRequest {
  accountId: string;
  startDate: string;
  endDate: string;
  clientHashes: Record<string, string>;
}

export const handler: APIGatewayProxyHandlerV2 = async (event) => {
  const userId = getUserId(event);
  if (!userId) return errorResponse(401, ErrorCodes.UNAUTHORIZED, 'Unauthorized');

  let body: SyncRequest;
  try {
    body = JSON.parse(event.body || '{}');
  } catch {
    return errorResponse(400, ErrorCodes.VALIDATION_ERROR, 'Invalid JSON body');
  }

  const { accountId, startDate, endDate, clientHashes = {} } = body;

  if (!accountId || !startDate || !endDate) {
    return errorResponse(400, ErrorCodes.VALIDATION_ERROR, 'accountId, startDate, and endDate are required');
  }

  try {
    const isAll = accountId === 'ALL';
    const records = isAll
      ? await queryAllAccounts(userId, startDate, endDate)
      : await querySingleAccount(userId, accountId, startDate, endDate);

    const serverHashes: Record<string, string> = {};
    if (isAll) {
      const dateHashMap = new Map<string, string[]>();
      for (const rec of records) {
        if (!rec.tradeHash || !rec.date) continue;
        const existing = dateHashMap.get(rec.date) || [];
        existing.push(`${rec.accountId}:${rec.tradeHash}`);
        dateHashMap.set(rec.date, existing);
      }
      for (const [date, hashes] of dateHashMap) {
        hashes.sort();
        serverHashes[date] = createHash('sha256').update(hashes.join('||')).digest('hex');
      }
    } else {
      for (const rec of records) {
        if (rec.tradeHash && rec.date) {
          serverHashes[rec.date] = rec.tradeHash;
        }
      }
    }

    const allDates = new Set<string>([
      ...Object.keys(serverHashes),
      ...Object.keys(clientHashes),
    ]);
    const staleDays: string[] = [];
    for (const date of allDates) {
      if (date < startDate || date > endDate) continue;
      if (clientHashes[date] !== serverHashes[date]) {
        staleDays.push(date);
      }
    }
    staleDays.sort();

    let trades: any[] = [];
    if (staleDays.length > 0) {
      trades = await fetchTradesForDays(userId, isAll ? undefined : accountId, staleDays);
    }

    return envelope({
      statusCode: 200,
      data: { serverHashes, staleDays, trades },
      message: 'Sync complete',
    });
  } catch (error: any) {
    console.error('Sync trades error', { error, userId, accountId });
    return errorResponse(500, ErrorCodes.INTERNAL_ERROR, 'Failed to sync trades');
  }
};

async function queryAllAccounts(
  userId: string, startDate: string, endDate: string,
): Promise<DailyStatsRecord[]> {
  const records: DailyStatsRecord[] = [];
  let exclusiveStartKey: Record<string, any> | undefined;
  do {
    const result = await ddb.send(new QueryCommand({
      TableName: DAILY_STATS_TABLE,
      IndexName: 'stats-by-date-gsi',
      KeyConditionExpression: 'userId = :userId AND #date BETWEEN :startDate AND :endDate',
      ExpressionAttributeNames: { '#date': 'date' },
      ExpressionAttributeValues: { ':userId': userId, ':startDate': startDate, ':endDate': endDate },
      ExclusiveStartKey: exclusiveStartKey,
    }));
    if (result.Items) records.push(...(result.Items as DailyStatsRecord[]));
    exclusiveStartKey = result.LastEvaluatedKey;
  } while (exclusiveStartKey);
  return records;
}

async function querySingleAccount(
  userId: string, accountId: string, startDate: string, endDate: string,
): Promise<DailyStatsRecord[]> {
  const records: DailyStatsRecord[] = [];
  let exclusiveStartKey: Record<string, any> | undefined;
  do {
    const result = await ddb.send(new QueryCommand({
      TableName: DAILY_STATS_TABLE,
      KeyConditionExpression: 'userId = :userId AND sk BETWEEN :skStart AND :skEnd',
      ExpressionAttributeValues: {
        ':userId': userId,
        ':skStart': `${accountId}#${startDate}`,
        ':skEnd': `${accountId}#${endDate}`,
      },
      ExclusiveStartKey: exclusiveStartKey,
    }));
    if (result.Items) records.push(...(result.Items as DailyStatsRecord[]));
    exclusiveStartKey = result.LastEvaluatedKey;
  } while (exclusiveStartKey);
  return records;
}

async function fetchTradesForDays(
  userId: string, accountId: string | undefined, staleDays: string[],
): Promise<any[]> {
  const allKeys: { userId: string; tradeId: string }[] = [];

  for (const day of staleDays) {
    const inclusiveEnd = day + 'T23:59:59.999Z';
    let exclusiveStartKey: Record<string, any> | undefined;
    do {
      const result = await ddb.send(new QueryCommand({
        TableName: TRADES_TABLE,
        IndexName: 'trades-by-date-gsi',
        KeyConditionExpression: 'userId = :u AND #od BETWEEN :start AND :end',
        ExpressionAttributeValues: { ':u': userId, ':start': day, ':end': inclusiveEnd },
        ExpressionAttributeNames: { '#od': 'openDate' },
        ExclusiveStartKey: exclusiveStartKey,
      }));
      if (result.Items) {
        for (const item of result.Items) {
          allKeys.push({ userId: item.userId, tradeId: item.tradeId });
        }
      }
      exclusiveStartKey = result.LastEvaluatedKey;
    } while (exclusiveStartKey);
  }

  if (allKeys.length === 0) return [];

  const chunks: { userId: string; tradeId: string }[][] = [];
  for (let i = 0; i < allKeys.length; i += 100) {
    chunks.push(allKeys.slice(i, i + 100));
  }

  const batchResults = await Promise.all(
    chunks.map(chunk =>
      ddb.send(new BatchGetCommand({
        RequestItems: { [TRADES_TABLE]: { Keys: chunk } },
      }))
    )
  );

  const items: any[] = [];
  for (const result of batchResults) {
    if (result.Responses?.[TRADES_TABLE]) {
      items.push(...result.Responses[TRADES_TABLE]);
    }
  }

  if (accountId) {
    return items.filter((it: any) => it.accountId === accountId);
  }
  return items;
}
