import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { GetCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { buildAdvancedStats } from '../../shared/advanced-stats';
import { wantsAdvancedSection } from '../../shared/statsSections';
import { getUserTimeZone } from '../../shared/timezone';
import { ddb } from '../../shared/dynamo';
import { queryDailyStats } from '../../shared/dailyStats';
import { getUserId } from '../../shared/auth';
import { envelope, errorResponse, ErrorCodes } from '../../shared/validation';
import { aggregateDailyRecords } from '../../shared/stats-aggregator';
import { AggregatedStats, AggregationContext, DailyStatsRecord } from '../../shared/metrics/types';

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
  let totalCapital = parsedCapital !== undefined && Number.isFinite(parsedCapital) ? parsedCapital : undefined;

  if (!accountId || !startDate || !endDate) {
    return errorResponse(400, ErrorCodes.VALIDATION_ERROR, 'accountId, startDate, and endDate are required');
  }

  try {
    // Drawdown is a percentage of the starting capital: one account's own initial balance when the caller sent none.
    if (totalCapital === undefined && accountId !== 'ALL') totalCapital = await accountInitialBalance(userId, accountId);

    const records = await queryDailyStats(userId, accountId, startDate, endDate);

    const dailyTradeHashes: Record<string, string> = {};
    for (const record of records) {
      if (record.tradeHash) {
        dailyTradeHashes[record.sk] = record.tradeHash;
      }
    }

    const stats = aggregate(records, { totalCapital, includeEquityCurve });

    // All accounts: also one aggregate per account currency (amounts in different currencies must not be summed).
    let perCurrency: Record<string, unknown> = {};
    if (accountId === 'ALL') {
      const currencies = await accountCurrencies(userId);
      const groups = new Map<string, DailyStatsRecord[]>();
      for (const record of records) {
        const currency = currencies.get(record.accountId) ?? 'UNKNOWN';
        groups.set(currency, [...(groups.get(currency) ?? []), record]);
      }
      perCurrency = {
        byCurrency: Object.fromEntries([...groups].map(([currency, rows]) => [currency, aggregate(rows, { totalCapital, includeEquityCurve })])),
        currencies: [...groups.keys()].sort(),
      };
    }

    // Day buckets, hours and weekdays follow the zone stored in the user's preferences (UTC when none is set).
    const timeZone = (await getUserTimeZone(userId).catch(() => null)) ?? 'UTC';

    const advanced = wantsAdvancedSection(query.sections) ? { advanced: buildAdvancedStats(stats, totalCapital) } : {};

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

/** The realised-R fields are present (null / 0) even for a range without daily records. */
function aggregate(records: DailyStatsRecord[], options: AggregationContext): AggregatedStats {
  return { avgR: null, sdR: null, rCount: 0, ...aggregateDailyRecords(records, options) };
}

async function accountInitialBalance(userId: string, accountId: string): Promise<number | undefined> {
  try {
    const res = await ddb.send(new GetCommand({
      TableName: process.env.ACCOUNTS_TABLE!,
      Key: { userId, accountId },
      ProjectionExpression: 'initialBalance',
    }));
    const v = res?.Item?.initialBalance;
    return typeof v === 'number' && v > 0 ? v : undefined;
  } catch {
    return undefined;
  }
}

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

