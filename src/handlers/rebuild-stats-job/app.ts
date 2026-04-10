import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, ScanCommand, PutCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const TRADES_TABLE = process.env.TRADES_TABLE!;
const STATS_TABLE = process.env.TRADE_STATS_TABLE!;
const ACCOUNTS_TABLE = process.env.ACCOUNTS_TABLE!;

// Periodic job: rebuild stats and account balances for every user.
export const handler = async () => {
  let lastEvaluatedKey: any = undefined;
  const userBuckets: Record<string, any[]> = {};
  do {
    const resp: any = await ddb.send(new ScanCommand({ TableName: TRADES_TABLE, ExclusiveStartKey: lastEvaluatedKey, ProjectionExpression: '#u,#t,symbol,side,entryPrice,exitPrice,quantity,accountId,pnl', ExpressionAttributeNames: { '#u': 'userId', '#t': 'tradeId' } }));
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
    const accountPnL: Record<string, number> = {};

    for (const t of trades) {
      const accountId = t.accountId;
      if (!accountId || accountId === '-1' || accountId === -1) continue;

      // Use stored pnl if available, fallback to calculation from prices
      const pnl = (t.pnl != null && typeof t.pnl === 'number')
        ? t.pnl
        : (t.entryPrice != null && t.exitPrice != null && t.quantity != null)
          ? (t.side === 'BUY' ? (t.exitPrice - t.entryPrice) * t.quantity : (t.entryPrice - t.exitPrice) * t.quantity)
          : null;
      if (pnl != null) {
        realizedPnL += pnl;
        if (pnl > 0) { wins++; sumWinPnL += pnl; if (pnl > bestWin) bestWin = pnl; }
        else if (pnl < 0) { losses++; sumLossPnL += pnl; if (pnl < worstLoss) worstLoss = pnl; }
        accountPnL[accountId] = (accountPnL[accountId] || 0) + pnl;
      }
    }

    await ddb.send(new PutCommand({ TableName: STATS_TABLE, Item: { userId, tradeCount, realizedPnL, wins, losses, bestWin, worstLoss, sumWinPnL, sumLossPnL, lastUpdated: new Date().toISOString(), source: 'periodic-job' } }));

    // Update account balances = initialBalance + totalPnL from trades
    for (const [accountId, totalPnL] of Object.entries(accountPnL)) {
      try {
        const accountResp = await ddb.send(new GetCommand({
          TableName: ACCOUNTS_TABLE,
          Key: { userId, accountId },
          ProjectionExpression: 'initialBalance',
        }));
        if (!accountResp.Item) continue;

        const initialBalance = accountResp.Item.initialBalance || 0;
        const newBalance = Math.round((initialBalance + totalPnL) * 100) / 100;

        await ddb.send(new UpdateCommand({
          TableName: ACCOUNTS_TABLE,
          Key: { userId, accountId },
          UpdateExpression: 'SET #balance = :balance, #updatedAt = :updatedAt',
          ExpressionAttributeNames: { '#balance': 'balance', '#updatedAt': 'updatedAt' },
          ExpressionAttributeValues: { ':balance': newBalance, ':updatedAt': new Date().toISOString() },
        }));
      } catch (e) {
        console.error(`Failed to update balance for account ${accountId}`, e);
      }
    }
  }
  return { rebuiltUsers: Object.keys(userBuckets).length };
};
