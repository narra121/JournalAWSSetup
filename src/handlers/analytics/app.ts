import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { QueryCommand } from '@aws-sdk/lib-dynamodb';
import { ddb } from '../../shared/dynamo';
import { makeLogger } from '../../shared/logger';
const TRADES_TABLE = process.env.TRADES_TABLE!;

type AnalyticsType = 'hourly' | 'daily-win-rate' | 'symbol-distribution' | 'strategy-distribution';

export const lambdaHandler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  const userId = event.requestContext.authorizer?.jwt.claims.sub as string;
  const type = (event.queryStringParameters?.type || 'hourly') as AnalyticsType;
  const logger = makeLogger({ requestId: event.requestContext.requestId, userId });
  
  console.log('Analytics request', { userId, type });

  try {
    let data: any;

    switch (type) {
      case 'hourly':
        data = await getHourlyStats(userId);
        break;
      case 'daily-win-rate':
        data = await getDailyWinRate(userId);
        break;
      case 'symbol-distribution':
        data = await getSymbolDistribution(userId);
        break;
      case 'strategy-distribution':
        data = await getStrategyDistribution(userId);
        break;
      default:
        return {
          statusCode: 400,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            success: false,
            error: {
              code: 'INVALID_TYPE',
              message: 'Invalid analytics type. Use: hourly, daily-win-rate, symbol-distribution, or strategy-distribution',
            },
          }),
        };
    }

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        success: true,
        data,
      }),
    };
  } catch (error) {
    console.error('Analytics error', { error, userId, type });
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        success: false,
        error: {
          code: 'ANALYTICS_ERROR',
          message: 'Failed to retrieve analytics',
        },
      }),
    };
  }
};

/**
 * Get hourly trading statistics (best/worst hours)
 */
async function getHourlyStats(userId: string) {
  const trades = await getAllUserTrades(userId);

  const hourlyStats: Record<number, { count: number; wins: number; totalPnl: number }> = {};

  for (const trade of trades) {
    if (!trade.openDate || !trade.pnl) continue;

    // Extract hour from openDate (assuming ISO format or similar)
    const hour = new Date(trade.openDate).getHours();

    if (!hourlyStats[hour]) {
      hourlyStats[hour] = { count: 0, wins: 0, totalPnl: 0 };
    }

    hourlyStats[hour].count++;
    hourlyStats[hour].totalPnl += trade.pnl;
    if (trade.pnl > 0) {
      hourlyStats[hour].wins++;
    }
  }

  const hourlyData = Object.entries(hourlyStats).map(([hour, stats]) => ({
    hour: parseInt(hour),
    count: stats.count,
    winRate: stats.count > 0 ? (stats.wins / stats.count) * 100 : 0,
    totalPnl: stats.totalPnl,
    avgPnl: stats.count > 0 ? stats.totalPnl / stats.count : 0,
  }));

  // Sort by hour
  hourlyData.sort((a, b) => a.hour - b.hour);

  return {
    hourlyStats: hourlyData,
    bestHour: hourlyData.reduce((best, curr) => (curr.totalPnl > best.totalPnl ? curr : best), hourlyData[0]),
    worstHour: hourlyData.reduce((worst, curr) => (curr.totalPnl < worst.totalPnl ? curr : worst), hourlyData[0]),
  };
}

/**
 * Get daily win rate over time
 */
async function getDailyWinRate(userId: string) {
  const trades = await getAllUserTrades(userId);

  const dailyStats: Record<string, { count: number; wins: number; totalPnl: number }> = {};

  for (const trade of trades) {
    if (!trade.openDate || !trade.pnl) continue;

    const date = trade.openDate.split('T')[0]; // Get YYYY-MM-DD

    if (!dailyStats[date]) {
      dailyStats[date] = { count: 0, wins: 0, totalPnl: 0 };
    }

    dailyStats[date].count++;
    dailyStats[date].totalPnl += trade.pnl;
    if (trade.pnl > 0) {
      dailyStats[date].wins++;
    }
  }

  const dailyData = Object.entries(dailyStats).map(([date, stats]) => ({
    date,
    count: stats.count,
    wins: stats.wins,
    losses: stats.count - stats.wins,
    winRate: stats.count > 0 ? (stats.wins / stats.count) * 100 : 0,
    totalPnl: stats.totalPnl,
  }));

  // Sort by date
  dailyData.sort((a, b) => a.date.localeCompare(b.date));

  return {
    dailyWinRate: dailyData,
    totalDays: dailyData.length,
    overallWinRate:
      dailyData.reduce((sum, day) => sum + day.wins, 0) /
      dailyData.reduce((sum, day) => sum + day.count, 0) *
      100,
  };
}

/**
 * Get symbol distribution (which symbols traded most)
 */
async function getSymbolDistribution(userId: string) {
  const trades = await getAllUserTrades(userId);

  const symbolStats: Record<string, { count: number; wins: number; totalPnl: number }> = {};

  for (const trade of trades) {
    if (!trade.symbol) continue;

    if (!symbolStats[trade.symbol]) {
      symbolStats[trade.symbol] = { count: 0, wins: 0, totalPnl: 0 };
    }

    symbolStats[trade.symbol].count++;
    if (trade.pnl && trade.pnl > 0) {
      symbolStats[trade.symbol].wins++;
    }
    if (trade.pnl) {
      symbolStats[trade.symbol].totalPnl += trade.pnl;
    }
  }

  const symbolData = Object.entries(symbolStats).map(([symbol, stats]) => ({
    symbol,
    count: stats.count,
    winRate: stats.count > 0 ? (stats.wins / stats.count) * 100 : 0,
    totalPnl: stats.totalPnl,
    avgPnl: stats.count > 0 ? stats.totalPnl / stats.count : 0,
  }));

  // Sort by count descending
  symbolData.sort((a, b) => b.count - a.count);

  return {
    symbols: symbolData,
    totalSymbols: symbolData.length,
    mostTraded: symbolData[0],
    mostProfitable: symbolData.reduce((best, curr) => (curr.totalPnl > best.totalPnl ? curr : best), symbolData[0]),
  };
}

/**
 * Get strategy distribution (which strategies used most)
 */
async function getStrategyDistribution(userId: string) {
  const trades = await getAllUserTrades(userId);

  const strategyStats: Record<string, { count: number; wins: number; totalPnl: number }> = {};

  for (const trade of trades) {
    const strategy = trade.setupType || 'Unknown';

    if (!strategyStats[strategy]) {
      strategyStats[strategy] = { count: 0, wins: 0, totalPnl: 0 };
    }

    strategyStats[strategy].count++;
    if (trade.pnl && trade.pnl > 0) {
      strategyStats[strategy].wins++;
    }
    if (trade.pnl) {
      strategyStats[strategy].totalPnl += trade.pnl;
    }
  }

  const strategyData = Object.entries(strategyStats).map(([strategy, stats]) => ({
    strategy,
    count: stats.count,
    winRate: stats.count > 0 ? (stats.wins / stats.count) * 100 : 0,
    totalPnl: stats.totalPnl,
    avgPnl: stats.count > 0 ? stats.totalPnl / stats.count : 0,
  }));

  // Sort by count descending
  strategyData.sort((a, b) => b.count - a.count);

  return {
    strategies: strategyData,
    totalStrategies: strategyData.length,
    mostUsed: strategyData[0],
    mostProfitable: strategyData.reduce(
      (best, curr) => (curr.totalPnl > best.totalPnl ? curr : best),
      strategyData[0]
    ),
  };
}

/**
 * Helper to get all trades for a user
 */
async function getAllUserTrades(userId: string) {
  const result = await ddb.send(
    new QueryCommand({
      TableName: TRADES_TABLE,
      KeyConditionExpression: 'userId = :userId',
      ExpressionAttributeValues: {
        ':userId': userId,
      },
    })
  );

  return result.Items || [];
}
