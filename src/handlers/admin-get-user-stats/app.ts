import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { envelope, errorResponse, ErrorCodes } from '../../shared/validation';
import { aggregateDailyRecords } from '../../shared/stats-aggregator';
import { queryDailyStats } from '../../shared/dailyStats';
import { makeLogger } from '../../shared/logger';


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
    const records = await queryDailyStats(userId, accountId, startDate, endDate);

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
    makeLogger({ requestId: event.requestContext?.requestId, userId }).error('Admin get user stats error', { error: error.message, accountId, startDate, endDate });
    return errorResponse(500, ErrorCodes.INTERNAL_ERROR, 'Failed to retrieve stats');
  }
};

