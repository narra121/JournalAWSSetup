import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { QueryCommand } from '@aws-sdk/lib-dynamodb';
import { ddb } from '../../shared/dynamo';
import { makeLogger } from '../../shared/logger';
import { envelope, errorResponse, ErrorCodes } from '../../shared/validation';
import { getUserId } from '../../shared/auth';
import { aggregateDailyRecords } from '../../shared/stats-aggregator';
import { DailyStatsRecord } from '../../shared/metrics/types';

const DAILY_STATS_TABLE = process.env.DAILY_STATS_TABLE!;

type AnalyticsType = 'hourly' | 'daily-win-rate' | 'symbol-distribution' | 'strategy-distribution';

export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  const userId = getUserId(event);

  if (!userId) {
    return errorResponse(401, ErrorCodes.UNAUTHORIZED, 'Unauthorized');
  }

  const type = event.queryStringParameters?.type || 'hourly';
  const validTypes: AnalyticsType[] = ['hourly', 'daily-win-rate', 'symbol-distribution', 'strategy-distribution'];
  if (!validTypes.includes(type as AnalyticsType)) {
    return errorResponse(400, ErrorCodes.VALIDATION_ERROR, 'Invalid analytics type. Use: hourly, daily-win-rate, symbol-distribution, or strategy-distribution');
  }
  const accountId = event.queryStringParameters?.accountId || 'ALL';
  const startDate = event.queryStringParameters?.startDate || '2000-01-01';
  const endDate = event.queryStringParameters?.endDate || new Date().toISOString().slice(0, 10);
  const logger = makeLogger({ requestId: event.requestContext.requestId, userId });

  try {
    // Query pre-aggregated DailyStats instead of scanning raw trades
    const records = accountId === 'ALL'
      ? await queryAllAccounts(userId, startDate, endDate)
      : await querySingleAccount(userId, accountId, startDate, endDate);

    // Use the same aggregation engine as get-stats
    const stats = aggregateDailyRecords(records, {});

    let data: any;
    switch (type as AnalyticsType) {
      case 'hourly':
        data = formatHourlyStats(stats.hourlyStats);
        break;
      case 'daily-win-rate':
        data = formatDailyWinRate(stats.dailyPnl, stats.dailyWinRate, stats.totalTrades, stats.winRate);
        break;
      case 'symbol-distribution':
        data = formatSymbolDistribution(stats.symbolDistribution);
        break;
      case 'strategy-distribution':
        data = formatStrategyDistribution(stats.strategyDistribution);
        break;
    }

    logger.info('Analytics retrieved', { type, accountId, recordCount: records.length });

    return envelope({
      statusCode: 200,
      data,
      message: 'Analytics retrieved successfully',
    });
  } catch (error: any) {
    console.error('Analytics error', { error, userId, type });
    return errorResponse(500, ErrorCodes.INTERNAL_ERROR, 'Failed to retrieve analytics', error.message);
  }
};

// ---------------------------------------------------------------------------
// Query helpers (same pattern as get-stats)
// ---------------------------------------------------------------------------

async function queryAllAccounts(userId: string, startDate: string, endDate: string): Promise<DailyStatsRecord[]> {
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

async function querySingleAccount(userId: string, accountId: string, startDate: string, endDate: string): Promise<DailyStatsRecord[]> {
  const records: DailyStatsRecord[] = [];
  let exclusiveStartKey: Record<string, any> | undefined;
  do {
    const result = await ddb.send(new QueryCommand({
      TableName: DAILY_STATS_TABLE,
      KeyConditionExpression: 'userId = :userId AND sk BETWEEN :skStart AND :skEnd',
      ExpressionAttributeValues: { ':userId': userId, ':skStart': `${accountId}#${startDate}`, ':skEnd': `${accountId}#${endDate}` },
      ExclusiveStartKey: exclusiveStartKey,
    }));
    if (result.Items) records.push(...(result.Items as DailyStatsRecord[]));
    exclusiveStartKey = result.LastEvaluatedKey;
  } while (exclusiveStartKey);
  return records;
}

// ---------------------------------------------------------------------------
// Format helpers — shape pre-aggregated stats into analytics response format
// ---------------------------------------------------------------------------

function formatHourlyStats(hourlyStats: Array<{ hour: string; trades: number; wins: number; pnl: number; winRate: number }>) {
  const hourlyData = hourlyStats
    .filter(h => h.trades > 0)
    .map(h => ({
      hour: parseInt(h.hour),
      count: h.trades,
      winRate: h.winRate,
      totalPnl: h.pnl,
      avgPnl: h.trades > 0 ? h.pnl / h.trades : 0,
    }))
    .sort((a, b) => a.hour - b.hour);

  return {
    hourlyStats: hourlyData,
    bestHour: hourlyData.length > 0 ? hourlyData.reduce((best, curr) => curr.totalPnl > best.totalPnl ? curr : best) : null,
    worstHour: hourlyData.length > 0 ? hourlyData.reduce((worst, curr) => curr.totalPnl < worst.totalPnl ? curr : worst) : null,
  };
}

function formatDailyWinRate(
  dailyPnl: Array<{ date: string; pnl: number; cumulativePnl: number }>,
  dailyWinRate: Array<{ day: string; trades: number; wins: number; pnl: number; winRate: number }>,
  totalTrades: number,
  overallWinRate: number,
) {
  return {
    dailyWinRate: dailyPnl.map(d => ({
      date: d.date,
      totalPnl: d.pnl,
      cumulativePnl: d.cumulativePnl,
    })),
    dayOfWeekStats: dailyWinRate.filter(d => d.trades > 0),
    totalDays: dailyPnl.length,
    overallWinRate,
  };
}

function formatSymbolDistribution(symbolDist: Record<string, { count: number; wins: number; pnl: number }>) {
  const symbolData = Object.entries(symbolDist).map(([symbol, stats]) => ({
    symbol,
    count: stats.count,
    winRate: stats.count > 0 ? (stats.wins / stats.count) * 100 : 0,
    totalPnl: stats.pnl,
    avgPnl: stats.count > 0 ? stats.pnl / stats.count : 0,
  })).sort((a, b) => b.count - a.count);

  return {
    symbols: symbolData,
    totalSymbols: symbolData.length,
    mostTraded: symbolData[0] || null,
    mostProfitable: symbolData.length > 0 ? symbolData.reduce((best, curr) => curr.totalPnl > best.totalPnl ? curr : best) : null,
  };
}

function formatStrategyDistribution(strategyDist: Record<string, { count: number; wins: number; pnl: number }>) {
  const strategyData = Object.entries(strategyDist).map(([strategy, stats]) => ({
    strategy,
    count: stats.count,
    winRate: stats.count > 0 ? (stats.wins / stats.count) * 100 : 0,
    totalPnl: stats.pnl,
    avgPnl: stats.count > 0 ? stats.pnl / stats.count : 0,
  })).sort((a, b) => b.count - a.count);

  return {
    strategies: strategyData,
    totalStrategies: strategyData.length,
    mostUsed: strategyData[0] || null,
    mostProfitable: strategyData.length > 0 ? strategyData.reduce((best, curr) => curr.totalPnl > best.totalPnl ? curr : best) : null,
  };
}
