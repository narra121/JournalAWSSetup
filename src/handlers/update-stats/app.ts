import { DynamoDBStreamHandler, DynamoDBStreamEvent } from 'aws-lambda';
import { ddb } from '../../shared/dynamo';
import { GetCommand, PutCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';

const STATS_TABLE = process.env.TRADE_STATS_TABLE!;

// Revised stats processor: idempotent full rebuild strategy for MODIFY and REMOVE events and any INSERT arriving closed.
// This ensures accurate realizedPnL, wins/losses, best/worst after exitPrice edits or deletions.
// Trade count = total trades for user. Closed trades contribute PnL.

async function rebuildStats(userId: string) {
  let lastEvaluatedKey: any = undefined;
  let tradeCount = 0;
  let realizedPnL = 0;
  let wins = 0;
  let losses = 0;
  let bestWin = 0;
  let worstLoss = 0; // negative
  let sumWinPnL = 0;
  let sumLossPnL = 0; // negative cumulative

  const calcPnL = (item: any) => {
    const entry = item.entryPrice;
    const exit = item.exitPrice;
    const qty = item.quantity;
    const side = item.side;
    if (entry == null || exit == null || qty == null || side == null) return undefined;
    if (side === 'BUY') return (exit - entry) * qty;
    if (side === 'SELL') return (entry - exit) * qty;
    return undefined;
  };

  do {
    const resp = await ddb.send(new QueryCommand({
      TableName: process.env.TRADES_TABLE!,
      KeyConditionExpression: 'userId = :u',
      ExpressionAttributeValues: { ':u': userId },
      ExclusiveStartKey: lastEvaluatedKey
    }));
    const items = resp.Items || [];
    tradeCount += items.length;
    for (const it of items) {
      const pnl = calcPnL(it);
      if (pnl !== undefined && pnl !== null) {
        realizedPnL += pnl;
        if (pnl > 0) { wins++; sumWinPnL += pnl; if (pnl > bestWin) bestWin = pnl; }
        else if (pnl < 0) { losses++; sumLossPnL += pnl; if (pnl < worstLoss) worstLoss = pnl; }
      }
    }
    lastEvaluatedKey = resp.LastEvaluatedKey;
  } while (lastEvaluatedKey);

  const stats = {
    userId,
    tradeCount,
    realizedPnL,
    wins,
    losses,
    bestWin,
    worstLoss,
    sumWinPnL,
    sumLossPnL,
    lastUpdated: new Date().toISOString()
  };
  await ddb.send(new PutCommand({ TableName: STATS_TABLE, Item: stats }));
}
export const handler: DynamoDBStreamHandler = async (event: DynamoDBStreamEvent) => {
  const failures: { itemIdentifier: string }[] = [];
  for (const record of event.Records) {
    if (!record.dynamodb) continue;
    const newImage = record.dynamodb.NewImage;
    const oldImage = record.dynamodb.OldImage;
    const imageRef = (newImage || oldImage);
    const userId = imageRef?.userId?.S;
    if (!userId) continue;
    try {
      if (record.eventName === 'INSERT') {
        // If trade inserted already closed, rebuild; else attempt light incremental tradeCount only
        const exitExists = !!newImage?.exitPrice?.N;
        if (exitExists) {
          await rebuildStats(userId);
        } else {
          // Minimal fast path: increment tradeCount only
          const current = await ddb.send(new GetCommand({ TableName: STATS_TABLE, Key: { userId } }));
          const stats = current.Item || { userId, tradeCount: 0, realizedPnL: 0, wins: 0, losses: 0, bestWin: 0, worstLoss: 0, sumWinPnL: 0, sumLossPnL: 0 };
          stats.tradeCount += 1;
          stats.lastUpdated = new Date().toISOString();
          await ddb.send(new PutCommand({ TableName: STATS_TABLE, Item: stats }));
        }
      } else if (record.eventName === 'MODIFY') {
        await rebuildStats(userId);
      } else if (record.eventName === 'REMOVE') {
        await rebuildStats(userId);
      }
    } catch (e) {
      console.error('Failed processing record', e);
      if (record.eventID) failures.push({ itemIdentifier: record.eventID });
    }
  }
  return { batchItemFailures: failures };
};
