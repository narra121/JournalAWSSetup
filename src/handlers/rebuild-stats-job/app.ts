import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, QueryCommand, ScanCommand, PutCommand } from '@aws-sdk/lib-dynamodb';

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const TRADES_TABLE = process.env.TRADES_TABLE!;
const STATS_TABLE = process.env.TRADE_STATS_TABLE!;

// Periodic job: rebuild stats for every user by scanning Trades table partitioned by userId.
export const handler = async () => {
  let lastEvaluatedKey: any = undefined;
  const userBuckets: Record<string, any[]> = {};
  do {
    const resp: any = await ddb.send(new ScanCommand({ TableName: TRADES_TABLE, ExclusiveStartKey: lastEvaluatedKey, ProjectionExpression: '#u,#t,symbol,side,entryPrice,exitPrice,quantity', ExpressionAttributeNames: { '#u': 'userId', '#t': 'tradeId' } }));
    const items = resp.Items || [];
    for (const it of items) {
      const uid = it.userId;
      (userBuckets[uid] ||= []).push(it);
    }
    lastEvaluatedKey = resp.LastEvaluatedKey;
  } while (lastEvaluatedKey);

  for (const [userId, trades] of Object.entries(userBuckets)) {
    let tradeCount = trades.length;
    let realizedPnL = 0, wins = 0, losses = 0, bestWin = 0, worstLoss = 0, sumWinPnL = 0, sumLossPnL = 0;
    for (const t of trades) {
      if (t.entryPrice != null && t.exitPrice != null && t.quantity != null) {
        const pnl = t.side === 'BUY' ? (t.exitPrice - t.entryPrice) * t.quantity : (t.entryPrice - t.exitPrice) * t.quantity;
        realizedPnL += pnl;
        if (pnl > 0) { wins++; sumWinPnL += pnl; if (pnl > bestWin) bestWin = pnl; }
        else if (pnl < 0) { losses++; sumLossPnL += pnl; if (pnl < worstLoss) worstLoss = pnl; }
      }
    }
    await ddb.send(new PutCommand({ TableName: STATS_TABLE, Item: { userId, tradeCount, realizedPnL, wins, losses, bestWin, worstLoss, sumWinPnL, sumLossPnL, lastUpdated: new Date().toISOString(), source: 'periodic-job' } }));
  }
  return { rebuiltUsers: Object.keys(userBuckets).length };
};
