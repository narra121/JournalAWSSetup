import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, ScanCommand, PutCommand, UpdateCommand, QueryCommand, DeleteCommand } from '@aws-sdk/lib-dynamodb';
import { computeDailyRecord } from '../../shared/stats-aggregator';
import { extractDate } from '../../shared/utils/pnl';

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const TRADES_TABLE = process.env.TRADES_TABLE!;
const ACCOUNTS_TABLE = process.env.ACCOUNTS_TABLE!;
const DAILY_STATS_TABLE = process.env.DAILY_STATS_TABLE!;

const WARN_THRESHOLD = 1000;

// ---------------------------------------------------------------------------
// Step 1: Find users with recent daily-stats changes (last 24 h)
// ---------------------------------------------------------------------------
async function getRecentlyChangedUserIds(): Promise<string[]> {
  const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const userIds = new Set<string>();
  let lastEvaluatedKey: any = undefined;

  do {
    const resp: any = await ddb.send(new ScanCommand({
      TableName: DAILY_STATS_TABLE,
      ExclusiveStartKey: lastEvaluatedKey,
      ProjectionExpression: 'userId',
      FilterExpression: 'lastUpdated >= :cutoff',
      ExpressionAttributeValues: { ':cutoff': cutoff },
    }));
    for (const item of resp.Items || []) {
      userIds.add(item.userId);
    }
    lastEvaluatedKey = resp.LastEvaluatedKey;
  } while (lastEvaluatedKey);

  return [...userIds];
}

// ---------------------------------------------------------------------------
// Step 2: Rebuild stats for a single user (trades query + stats + balances + daily stats)
// ---------------------------------------------------------------------------
async function rebuildForUser(userId: string): Promise<void> {
  // Fetch all trades for this user
  let lastEvaluatedKey: any = undefined;
  const trades: any[] = [];
  do {
    const resp: any = await ddb.send(new QueryCommand({
      TableName: TRADES_TABLE,
      KeyConditionExpression: 'userId = :u',
      ExpressionAttributeValues: { ':u': userId },
      ProjectionExpression: '#u,#t,symbol,side,entryPrice,exitPrice,quantity,accountId,pnl,openDate,closeDate,setupType,tradingSession,outcome,riskRewardRatio,stopLoss,takeProfit,tags,marketCondition',
      ExpressionAttributeNames: { '#u': 'userId', '#t': 'tradeId' },
      ExclusiveStartKey: lastEvaluatedKey,
    }));
    trades.push(...(resp.Items || []));
    lastEvaluatedKey = resp.LastEvaluatedKey;
  } while (lastEvaluatedKey);

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
      accountPnL[accountId] = (accountPnL[accountId] || 0) + pnl;
    }
  }

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

  // --- Rebuild DailyStatsTable ---
  // Group trades by (userId, accountId, date)
  const dailyGroups = new Map<string, any[]>();
  for (const t of trades) {
    const accountId = t.accountId;
    if (!accountId || accountId === '-1' || accountId === -1) continue;
    const date = extractDate(t.openDate);
    if (!date) continue;
    const key = `${accountId}#${date}`;
    const group = dailyGroups.get(key);
    if (group) { group.push(t); } else { dailyGroups.set(key, [t]); }
  }

  // Compute and write daily records
  const newSkSet = new Set<string>();
  for (const [key, groupTrades] of dailyGroups) {
    const [accountId, date] = key.split('#');
    const record = computeDailyRecord(userId, accountId, date, groupTrades);
    if (record) {
      newSkSet.add(record.sk);
      await ddb.send(new PutCommand({ TableName: DAILY_STATS_TABLE, Item: record }));
    }
  }

  // Orphan cleanup: delete daily stats records that no longer have trades
  let dailyLastKey: any = undefined;
  do {
    const queryResp: any = await ddb.send(new QueryCommand({
      TableName: DAILY_STATS_TABLE,
      KeyConditionExpression: 'userId = :uid',
      ExpressionAttributeValues: { ':uid': userId },
      ProjectionExpression: 'userId, sk',
      ExclusiveStartKey: dailyLastKey,
    }));
    const existingItems = queryResp.Items || [];
    for (const item of existingItems) {
      if (!newSkSet.has(item.sk)) {
        await ddb.send(new DeleteCommand({
          TableName: DAILY_STATS_TABLE,
          Key: { userId: item.userId, sk: item.sk },
        }));
      }
    }
    dailyLastKey = queryResp.LastEvaluatedKey;
  } while (dailyLastKey);
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

// Periodic job: rebuild stats, account balances, and daily stats for users
// with recent changes (last 24 hours).
export const handler = async () => {
  console.log('rebuild-stats-job started', { timestamp: new Date().toISOString() });

  // Find users with recent daily-stats changes
  const recentUserIds = await getRecentlyChangedUserIds();

  if (recentUserIds.length === 0) {
    return { rebuiltUsers: 0, skipped: 'no recent changes' };
  }

  // Warn if unusually high — but process ALL users, never skip
  if (recentUserIds.length > WARN_THRESHOLD) {
    console.warn(`rebuild-stats-job: ${recentUserIds.length} users need rebuilding (above ${WARN_THRESHOLD} threshold)`);
  }

  // Process 5 users concurrently — each user's rebuild is independent (different partition key)
  const CONCURRENT_USERS = 5;
  const allErrors: Error[] = [];
  for (let i = 0; i < recentUserIds.length; i += CONCURRENT_USERS) {
    const batch = recentUserIds.slice(i, i + CONCURRENT_USERS);
    const results = await Promise.allSettled(
      batch.map(userId => rebuildForUser(userId))
    );
    for (const result of results) {
      if (result.status === 'rejected') {
        allErrors.push(result.reason);
      }
    }
  }

  // Re-throw the first error so callers (and tests) see the failure
  if (allErrors.length > 0) {
    throw allErrors[0];
  }

  return { rebuiltUsers: recentUserIds.length };
};
