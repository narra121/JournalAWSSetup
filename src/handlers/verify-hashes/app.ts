import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { QueryCommand } from '@aws-sdk/lib-dynamodb';
import { ddb } from '../../shared/dynamo';
import { getUserId } from '../../shared/auth';
import { envelope, errorResponse, ErrorCodes } from '../../shared/validation';

const DAILY_STATS_TABLE = process.env.DAILY_STATS_TABLE!;

interface VerifyHashesRequest {
  accountId: string;
  startDate: string;
  endDate: string;
  clientMonthHashes: Record<string, string>;
  clientDayHashes: Record<string, string>;
}

interface DailyRecord {
  sk: string;
  tradeHash?: string;
  date?: string;
  accountId?: string;
}

interface MonthlyRecord {
  sk: string;
  monthHash: string;
  accountId: string;
  month: string;
}

export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  const userId = getUserId(event);
  if (!userId) {
    return errorResponse(401, ErrorCodes.UNAUTHORIZED, 'Unauthorized');
  }

  let body: VerifyHashesRequest;
  try {
    body = JSON.parse(event.body || '{}');
  } catch {
    return errorResponse(400, ErrorCodes.VALIDATION_ERROR, 'Invalid JSON body');
  }

  const { accountId, startDate, endDate, clientMonthHashes, clientDayHashes } = body;

  if (!accountId || !startDate || !endDate) {
    return errorResponse(400, ErrorCodes.VALIDATION_ERROR, 'accountId, startDate, and endDate are required');
  }

  if (!clientMonthHashes || typeof clientMonthHashes !== 'object') {
    return errorResponse(400, ErrorCodes.VALIDATION_ERROR, 'clientMonthHashes is required and must be an object');
  }

  if (!clientDayHashes || typeof clientDayHashes !== 'object') {
    return errorResponse(400, ErrorCodes.VALIDATION_ERROR, 'clientDayHashes is required and must be an object');
  }

  try {
    const startMonth = startDate.slice(0, 7);
    const endMonth = endDate.slice(0, 7);

    let dailyRecords: DailyRecord[];
    let monthlyRecords: MonthlyRecord[];

    if (accountId === 'ALL') {
      // Use GSI for daily records, then query monthly per discovered account
      dailyRecords = await queryAllAccountsDaily(userId, startDate, endDate);

      // Discover unique accounts from daily records
      const accountIds = new Set<string>();
      for (const rec of dailyRecords) {
        if (rec.accountId) {
          accountIds.add(rec.accountId);
        }
      }

      // Query monthly records for each discovered account
      monthlyRecords = [];
      for (const accId of accountIds) {
        const monthRecs = await queryMonthlyRecords(userId, accId, startMonth, endMonth);
        monthlyRecords.push(...monthRecs);
      }
    } else {
      // Two queries for a single account
      [dailyRecords, monthlyRecords] = await Promise.all([
        querySingleAccountDaily(userId, accountId, startDate, endDate),
        queryMonthlyRecords(userId, accountId, startMonth, endMonth),
      ]);
    }

    // Build server hash maps
    const serverMonthHashes: Record<string, string> = {};
    for (const rec of monthlyRecords) {
      const key = `${rec.accountId}#${rec.month}`;
      serverMonthHashes[key] = rec.monthHash;
    }

    const serverDayHashes: Record<string, string> = {};
    for (const rec of dailyRecords) {
      if (rec.tradeHash) {
        serverDayHashes[rec.sk] = rec.tradeHash;
      }
    }

    // Extract month from a day key like "acc-1#2026-04-15" -> "acc-1#2026-04"
    function getMonthKeyFromDayKey(dayKey: string): string {
      const hashIdx = dayKey.indexOf('#');
      const accId = dayKey.slice(0, hashIdx);
      const date = dayKey.slice(hashIdx + 1);
      return `${accId}#${date.slice(0, 7)}`;
    }

    // Two-level comparison
    // 1. Discover all months from month hashes AND daily records
    const allMonthKeys = new Set<string>([
      ...Object.keys(clientMonthHashes),
      ...Object.keys(serverMonthHashes),
    ]);

    // Also discover months from daily records (handles case where monthly
    // hash records don't exist yet, e.g. before the feature was deployed)
    for (const dayKey of Object.keys(serverDayHashes)) {
      allMonthKeys.add(getMonthKeyFromDayKey(dayKey));
    }
    for (const dayKey of Object.keys(clientDayHashes)) {
      allMonthKeys.add(getMonthKeyFromDayKey(dayKey));
    }

    const matchedMonths = new Set<string>();
    const staleMonths = new Set<string>();

    for (const monthKey of allMonthKeys) {
      const clientHash = clientMonthHashes[monthKey];
      const serverHash = serverMonthHashes[monthKey];

      if (clientHash && serverHash && clientHash === serverHash) {
        matchedMonths.add(monthKey);
      } else {
        staleMonths.add(monthKey);
      }
    }

    // 2. For stale months, compare day hashes
    const staleDays: string[] = [];
    const staleMonthServerDayHashes: Record<string, string> = {};
    const staleMonthServerMonthHashes: Record<string, string> = {};

    // Collect all day keys from stale months
    const allDayKeys = new Set<string>([
      ...Object.keys(clientDayHashes).filter(k => staleMonths.has(getMonthKeyFromDayKey(k))),
      ...Object.keys(serverDayHashes).filter(k => staleMonths.has(getMonthKeyFromDayKey(k))),
    ]);

    for (const dayKey of allDayKeys) {
      const clientHash = clientDayHashes[dayKey];
      const serverHash = serverDayHashes[dayKey];

      if (clientHash && serverHash && clientHash === serverHash) {
        // Day matches, not stale
      } else {
        staleDays.push(dayKey);
      }
    }

    // Include server hashes for stale months only
    for (const monthKey of staleMonths) {
      if (serverMonthHashes[monthKey]) {
        staleMonthServerMonthHashes[monthKey] = serverMonthHashes[monthKey];
      }
    }

    for (const dayKey of Object.keys(serverDayHashes)) {
      const monthKey = getMonthKeyFromDayKey(dayKey);
      if (staleMonths.has(monthKey)) {
        staleMonthServerDayHashes[dayKey] = serverDayHashes[dayKey];
      }
    }

    const batchMatch = staleMonths.size === 0;

    return envelope({
      statusCode: 200,
      data: {
        batchMatch,
        staleDays: staleDays.sort(),
        serverMonthHashes: staleMonthServerMonthHashes,
        serverDayHashes: staleMonthServerDayHashes,
      },
      message: 'Hash verification completed',
    });
  } catch (error: any) {
    console.error('Verify hashes error', { error, userId, accountId, startDate, endDate });
    return errorResponse(500, ErrorCodes.INTERNAL_ERROR, 'Failed to verify hashes', error.message);
  }
};

/**
 * Query daily records for all accounts using the GSI (stats-by-date-gsi).
 * PK = userId, SK = date BETWEEN startDate AND endDate.
 */
async function queryAllAccountsDaily(
  userId: string,
  startDate: string,
  endDate: string,
): Promise<DailyRecord[]> {
  const records: DailyRecord[] = [];
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
        ProjectionExpression: 'sk, tradeHash, #date, accountId',
        ExclusiveStartKey: exclusiveStartKey,
      }),
    );

    if (result.Items) {
      records.push(...(result.Items as DailyRecord[]));
    }

    exclusiveStartKey = result.LastEvaluatedKey;
  } while (exclusiveStartKey);

  return records;
}

/**
 * Query daily records for a single account using the main table.
 * PK = userId, SK BETWEEN "accountId#startDate" AND "accountId#endDate".
 */
async function querySingleAccountDaily(
  userId: string,
  accountId: string,
  startDate: string,
  endDate: string,
): Promise<DailyRecord[]> {
  const records: DailyRecord[] = [];
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
        ProjectionExpression: 'sk, tradeHash, accountId',
        ExclusiveStartKey: exclusiveStartKey,
      }),
    );

    if (result.Items) {
      records.push(...(result.Items as DailyRecord[]));
    }

    exclusiveStartKey = result.LastEvaluatedKey;
  } while (exclusiveStartKey);

  return records;
}

/**
 * Query monthly hash records for a single account.
 * PK = userId, SK BETWEEN "accountId#MONTH#startMonth" AND "accountId#MONTH#endMonth".
 */
async function queryMonthlyRecords(
  userId: string,
  accountId: string,
  startMonth: string,
  endMonth: string,
): Promise<MonthlyRecord[]> {
  const records: MonthlyRecord[] = [];
  let exclusiveStartKey: Record<string, any> | undefined;

  do {
    const result = await ddb.send(
      new QueryCommand({
        TableName: DAILY_STATS_TABLE,
        KeyConditionExpression: 'userId = :userId AND sk BETWEEN :skStart AND :skEnd',
        ExpressionAttributeValues: {
          ':userId': userId,
          ':skStart': `${accountId}#MONTH#${startMonth}`,
          ':skEnd': `${accountId}#MONTH#${endMonth}`,
        },
        ProjectionExpression: 'sk, monthHash, accountId, #m',
        ExpressionAttributeNames: { '#m': 'month' },
        ExclusiveStartKey: exclusiveStartKey,
      }),
    );

    if (result.Items) {
      records.push(...(result.Items as MonthlyRecord[]));
    }

    exclusiveStartKey = result.LastEvaluatedKey;
  } while (exclusiveStartKey);

  return records;
}
