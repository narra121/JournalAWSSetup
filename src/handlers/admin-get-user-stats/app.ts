import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { QueryCommand } from '@aws-sdk/lib-dynamodb';
import { ddb } from '../../shared/dynamo';
import { envelope, errorResponse, ErrorCodes } from '../../shared/validation';
import { aggregateDailyRecords } from '../../shared/stats-aggregator';
import { DailyStatsRecord } from '../../shared/metrics/types';

const DAILY_STATS_TABLE = process.env.DAILY_STATS_TABLE!;

export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  const userId = event.pathParameters?.userId;
  if (!userId) {
    return errorResponse(400, ErrorCodes.VALIDATION_ERROR, 'userId path parameter is required');
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

    return envelope({
      statusCode: 200,
      data: { ...stats, dailyTradeHashes },
      message: 'Stats retrieved successfully',
    });
  } catch (error: any) {
    console.error('Admin get user stats error', { error, userId, accountId, startDate, endDate });
    return errorResponse(500, ErrorCodes.INTERNAL_ERROR, 'Failed to retrieve stats', error.message);
  }
};

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
