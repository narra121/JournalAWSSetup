import { DynamoDBStreamHandler, DynamoDBStreamEvent } from 'aws-lambda';
import { ddb } from '../../shared/dynamo';
import { GetCommand, PutCommand, QueryCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';

const STATS_TABLE = process.env.TRADE_STATS_TABLE!;
const ACCOUNTS_TABLE = process.env.ACCOUNTS_TABLE!;

// Revised stats processor: idempotent full rebuild strategy for MODIFY and REMOVE events and any INSERT arriving closed.
// This ensures accurate realizedPnL, wins/losses, best/worst after exitPrice edits or deletions.
// Trade count = total trades for user. Closed trades contribute PnL.
// Also updates account balances based on trade PnL.

const calcPnL = (item: any) => {
  // Use the stored pnl field if available (frontend pre-calculates this)
  if (item.pnl != null && typeof item.pnl === 'number') return item.pnl;
  // Fallback: calculate from prices
  const entry = item.entryPrice;
  const exit = item.exitPrice;
  const qty = item.quantity;
  const side = item.side;
  if (entry == null || exit == null || qty == null || side == null) return undefined;
  if (side === 'BUY') return (exit - entry) * qty;
  if (side === 'SELL') return (entry - exit) * qty;
  return undefined;
};

async function rebuildStats(userId: string) {
  let lastEvaluatedKey: any = undefined;
  let tradeCount = 0;
  let realizedPnL = 0;
  let wins = 0;
  let losses = 0;
  let bestWin = 0;
  let worstLoss = 0;
  let sumWinPnL = 0;
  let sumLossPnL = 0;

  // Track PnL per account for balance updates
  const accountPnL: Record<string, number> = {};

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
      const accountId = it.accountId;
      if (!accountId || accountId === '-1' || accountId === -1) continue;

      const pnl = calcPnL(it);
      if (pnl !== undefined && pnl !== null) {
        realizedPnL += pnl;
        if (pnl > 0) { wins++; sumWinPnL += pnl; if (pnl > bestWin) bestWin = pnl; }
        else if (pnl < 0) { losses++; sumLossPnL += pnl; if (pnl < worstLoss) worstLoss = pnl; }

        // Accumulate PnL per account
        accountPnL[accountId] = (accountPnL[accountId] || 0) + pnl;
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

  // Update each account's balance = initialBalance + totalPnL from trades
  await updateAccountBalances(userId, accountPnL);
}

async function updateAccountBalances(userId: string, accountPnL: Record<string, number>) {
  for (const [accountId, totalPnL] of Object.entries(accountPnL)) {
    try {
      // Get account to read initialBalance
      const accountResp = await ddb.send(new GetCommand({
        TableName: ACCOUNTS_TABLE,
        Key: { userId, accountId },
        ProjectionExpression: 'initialBalance',
      }));
      if (!accountResp.Item) continue;

      const initialBalance = accountResp.Item.initialBalance || 0;
      const newBalance = initialBalance + totalPnL;

      await ddb.send(new UpdateCommand({
        TableName: ACCOUNTS_TABLE,
        Key: { userId, accountId },
        UpdateExpression: 'SET #balance = :balance, #updatedAt = :updatedAt',
        ExpressionAttributeNames: { '#balance': 'balance', '#updatedAt': 'updatedAt' },
        ExpressionAttributeValues: { ':balance': Math.round(newBalance * 100) / 100, ':updatedAt': new Date().toISOString() },
      }));
    } catch (e) {
      console.error(`Failed to update balance for account ${accountId}`, e);
    }
  }
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
      // Full rebuild on any trade change (INSERT/MODIFY/REMOVE)
      // This recalculates stats AND updates account balances
      await rebuildStats(userId);
    } catch (e) {
      console.error('Failed processing record', e);
      if (record.eventID) failures.push({ itemIdentifier: record.eventID });
    }
  }
  return { batchItemFailures: failures };
};
