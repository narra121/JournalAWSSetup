import { DynamoDBDocumentClient, ScanCommand, BatchWriteCommand } from '@aws-sdk/lib-dynamodb';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { computeDailyRecord } from '../../shared/stats-aggregator';
import { extractDate } from '../../shared/utils/pnl';

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const TRADES_TABLE = process.env.TRADES_TABLE!;
const DAILY_STATS_TABLE = process.env.DAILY_STATS_TABLE!;

export const handler = async () => {
  // 1. Scan entire Trades table (paginated, all fields needed)
  let lastEvaluatedKey: any = undefined;
  const allTrades: any[] = [];
  do {
    const resp: any = await ddb.send(new ScanCommand({
      TableName: TRADES_TABLE,
      ExclusiveStartKey: lastEvaluatedKey,
      ProjectionExpression: 'userId, tradeId, accountId, symbol, side, quantity, openDate, closeDate, entryPrice, exitPrice, stopLoss, takeProfit, pnl, riskRewardRatio, outcome, setupType, tradingSession, marketCondition, brokenRuleIds, tags',
    }));
    const items = resp.Items || [];
    allTrades.push(...items);
    lastEvaluatedKey = resp.LastEvaluatedKey;
  } while (lastEvaluatedKey);

  // 2. Group by (userId, accountId, extractDate(openDate)) — skip accountId=-1
  const groups = new Map<string, any[]>();
  const userIds = new Set<string>();
  for (const trade of allTrades) {
    const accountId = trade.accountId;
    if (!accountId || accountId === '-1' || accountId === -1) continue;
    const date = extractDate(trade.openDate);
    if (!date) continue;
    const key = `${trade.userId}#${accountId}#${date}`;
    userIds.add(trade.userId);
    const group = groups.get(key);
    if (group) { group.push(trade); } else { groups.set(key, [trade]); }
  }

  // 3. For each group: computeDailyRecord()
  const records: any[] = [];
  for (const [key, trades] of groups) {
    const [userId, accountId, date] = key.split('#');
    const record = computeDailyRecord(userId, accountId, date, trades);
    if (record) {
      records.push(record);
    }
  }

  // 4. BatchWrite to DailyStatsTable (chunks of 25, with unprocessed items retry)
  const BATCH_SIZE = 25;
  const MAX_RETRIES = 3;

  for (let i = 0; i < records.length; i += BATCH_SIZE) {
    const chunk = records.slice(i, i + BATCH_SIZE);
    let requestItems: any[] = chunk.map(item => ({
      PutRequest: { Item: item },
    }));

    for (let attempt = 0; attempt < MAX_RETRIES && requestItems.length > 0; attempt++) {
      const resp: any = await ddb.send(new BatchWriteCommand({
        RequestItems: {
          [DAILY_STATS_TABLE]: requestItems,
        },
      }));

      const unprocessed = resp.UnprocessedItems?.[DAILY_STATS_TABLE];
      if (!unprocessed || unprocessed.length === 0) break;

      requestItems = unprocessed;
      // Exponential backoff before retry
      if (attempt < MAX_RETRIES - 1) {
        await new Promise(resolve => setTimeout(resolve, Math.pow(2, attempt) * 100));
      }
    }
  }

  const usersProcessed = userIds.size;
  const dailyRecordsCreated = records.length;

  // 5. Return summary
  console.log(`Processed ${groups.size} groups for ${usersProcessed} users`);
  return { status: 'complete', usersProcessed, dailyRecordsCreated };
};
