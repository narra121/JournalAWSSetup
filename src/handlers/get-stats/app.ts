import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { QueryCommand } from '@aws-sdk/lib-dynamodb';
import { buildAdvancedStats } from '../../shared/advanced-stats';
import { getUserTimeZone } from '../../shared/timezone';
import { ddb } from '../../shared/dynamo';
import { getUserId } from '../../shared/auth';
import { envelope, errorResponse, ErrorCodes } from '../../shared/validation';
import { aggregateDailyRecords } from '../../shared/stats-aggregator';
import { DailyStatsRecord } from '../../shared/metrics/types';

const DAILY_STATS_TABLE = process.env.DAILY_STATS_TABLE!;

export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  const userId = getUserId(event);
  if (!userId) {
    return errorResponse(401, ErrorCodes.UNAUTHORIZED, 'Unauthorized');
  }

  const query = event.queryStringParameters || {};
  const accountId = query.accountId;
  const startDate = query.startDate;
  const endDate = query.endDate;
  const includeEquityCurve = query.includeEquityCurve === 'true';
  const parsedCapital = query.totalCapital ? parseFloat(query.totalCapital) : undefined;
  const totalCapital = parsedCapital !== undefined && Number.isFinite(parsedCapital) ? parsedCapital : undefined;

  if (!accountId || !startDate || !endDate) {
    return errorResponse(400, ErrorCodes.VALIDATION_ERROR, 'accountId, startDate, and endDate are required');
  }

  try {
    const records = accountId === 'ALL'
      ? await queryAllAccounts(userId, startDate, endDate)
      : await querySingleAccount(userId, accountId, startDate, endDate);

    const dailyTradeHashes: Record<string, string> = {};
    for (const record of records) {
      if (record.tradeHash) {
        dailyTradeHashes[record.sk] = record.tradeHash;
      }
    }

    const stats = aggregateDailyRecords(records, { totalCapital, includeEquityCurve });

    // All accounts: also one aggregate per account currency (amounts in different currencies must not be summed).
    let perCurrency: Record<string, unknown> = {};
    if (accountId === 'ALL') {
      const currencies = await accountCurrencies(userId);
      const groups = new Map<string, DailyStatsRecord[]>();
      const unassigned: DailyStatsRecord[] = [];
      for (const record of records) {
        if (record.accountId === '-1') unassigned.push(record);
        else {
          const currency = currencies.get(record.accountId) ?? 'UNKNOWN';
          groups.set(currency, [...(groups.get(currency) ?? []), record]);
        }
      }
      perCurrency = {
        byCurrency: Object.fromEntries([...groups].map(([currency, rows]) => [currency, aggregateDailyRecords(rows, { totalCapital, includeEquityCurve })])),
        unassigned: unassigned.length ? aggregateDailyRecords(unassigned, { totalCapital, includeEquityCurve }) : null,
        currencies: [...groups.keys()].sort(),
      };
    }

    // Day buckets, hours and weekdays follow the zone stored in the user's preferences (UTC when none is set).
    const timeZone = (await getUserTimeZone(userId).catch(() => null)) ?? 'UTC';

    const sections = (query.sections || '').split(',');
    const advanced = sections.includes('advanced') ? { advanced: buildAdvancedStats(stats, totalCapital) } : {};

    return envelope({
      statusCode: 200,
      data: { ...stats, ...perCurrency, ...advanced, timeZone, dailyTradeHashes },
      message: 'Stats retrieved successfully',
    });
  } catch (error: any) {
    console.error('Get stats error', { error, userId, accountId, startDate, endDate });
    return errorResponse(500, ErrorCodes.INTERNAL_ERROR, 'Failed to retrieve stats');
  }
};

/** accountId → currency for the user's accounts. */
async function accountCurrencies(userId: string): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  let key: Record<string, any> | undefined;
  do {
    const res = await ddb.send(new QueryCommand({
      TableName: process.env.ACCOUNTS_TABLE!,
      KeyConditionExpression: 'userId = :u',
      ExpressionAttributeValues: { ':u': userId },
      ProjectionExpression: 'accountId, currency',
      ExclusiveStartKey: key,
    }));
    for (const it of res.Items ?? []) map.set(it.accountId, String(it.currency ?? 'UNKNOWN').toUpperCase());
    key = res.LastEvaluatedKey;
  } while (key);
  return map;
}

/**
 * Query all accounts using the GSI (stats-by-date-gsi).
 * PK = userId, SK = date BETWEEN startDate AND endDate.
 * Handles pagination via LastEvaluatedKey.
 */
async function queryAllAccounts(
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

/**
 * Query a single account using the main table.
 * PK = userId, SK BETWEEN "accountId#startDate" AND "accountId#endDate".
 * Handles pagination via LastEvaluatedKey.
 */
async function querySingleAccount(
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
