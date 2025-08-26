import { APIGatewayProxyHandlerV2 } from 'aws-lambda';
import { ddb } from '../../shared/dynamo';
import { GetCommand } from '@aws-sdk/lib-dynamodb';

const STATS_TABLE = process.env.TRADE_STATS_TABLE!;

export const handler: APIGatewayProxyHandlerV2 = async (event) => {
  try {
  const rc: any = event.requestContext as any;
  const userId = rc?.authorizer?.jwt?.claims?.sub;
    if (!userId) return resp(401, { message: 'Unauthorized' });

    const result = await ddb.send(new GetCommand({
      TableName: STATS_TABLE,
      Key: { userId }
    }));

  const base = result.Item || { userId, tradeCount: 0, realizedPnL: 0, wins: 0, losses: 0, bestWin: 0, worstLoss: 0, sumWinPnL: 0, sumLossPnL: 0, lastUpdated: null };
  const winRate = (base.wins + base.losses) > 0 ? base.wins / (base.wins + base.losses) : 0;
  const avgWin = base.wins > 0 ? base.sumWinPnL / base.wins : 0;
  const avgLoss = base.losses > 0 ? base.sumLossPnL / base.losses : 0; // negative
  const expectancy = (winRate * avgWin) + ((1 - winRate) * avgLoss); // could be negative
  return resp(200, { ...base, winRate, avgWin, avgLoss, expectancy });
  } catch (e) {
    console.error(e);
    return resp(500, { message: 'Internal error' });
  }
};

function resp(statusCode: number, body: any) {
  return { statusCode, body: JSON.stringify(body) };
}
