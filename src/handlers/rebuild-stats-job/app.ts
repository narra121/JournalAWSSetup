import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, UpdateCommand, QueryCommand, DeleteCommand } from '@aws-sdk/lib-dynamodb';
import { computeDailyRecord } from '../../shared/stats-aggregator';
import { dayOf, getUserTimeZone, isCalendarDay } from '../../shared/timezone';
import { calcPnL } from '../../shared/utils/pnl';
import { batchWritePutAll, batchWriteDeleteAll } from '../../shared/batchWrite';
import { STATS_DIRTY_PK } from '../../shared/statsDirty';

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const TRADES_TABLE = process.env.TRADES_TABLE!;
const ACCOUNTS_TABLE = process.env.ACCOUNTS_TABLE!;
const DAILY_STATS_TABLE = process.env.DAILY_STATS_TABLE!;

const WARN_THRESHOLD = 1000;
const BALANCE_ATTEMPTS = 3;

const isValidAccount = (accountId: any) => !!accountId && accountId !== '-1' && accountId !== -1;

// ---------------------------------------------------------------------------
// Step 1: Users flagged by update-stats since their last rebuild
// ---------------------------------------------------------------------------
async function getDirtyUsers(): Promise<{ userId: string; dirtyAt: string }[]> {
  const users: { userId: string; dirtyAt: string }[] = [];
  let lastEvaluatedKey: any = undefined;

  do {
    const resp: any = await ddb.send(new QueryCommand({
      TableName: DAILY_STATS_TABLE,
      KeyConditionExpression: 'userId = :pk',
      ExpressionAttributeValues: { ':pk': STATS_DIRTY_PK },
      ExclusiveStartKey: lastEvaluatedKey,
    }));
    for (const item of resp.Items || []) users.push({ userId: item.sk, dirtyAt: item.dirtyAt });
    lastEvaluatedKey = resp.LastEvaluatedKey;
  } while (lastEvaluatedKey);

  return users;
}

/** Removes the flag unless update-stats set it again after it was read (that change needs another rebuild). */
async function clearDirty(userId: string, dirtyAt: string): Promise<void> {
  try {
    await ddb.send(new DeleteCommand({
      TableName: DAILY_STATS_TABLE,
      Key: { userId: STATS_DIRTY_PK, sk: userId },
      ConditionExpression: 'dirtyAt = :seen',
      ExpressionAttributeValues: { ':seen': dirtyAt },
    }));
  } catch (e: any) {
    if (e.name !== 'ConditionalCheckFailedException') throw e;
  }
}

// ---------------------------------------------------------------------------
// Step 2: Rebuild stats for a single user (trades query + balances + daily stats)
// ---------------------------------------------------------------------------
async function loadTrades(userId: string): Promise<any[]> {
  let lastEvaluatedKey: any = undefined;
  const trades: any[] = [];
  do {
    const resp: any = await ddb.send(new QueryCommand({
      TableName: TRADES_TABLE,
      KeyConditionExpression: 'userId = :u',
      ExpressionAttributeValues: { ':u': userId },
      ProjectionExpression: '#u,#t,symbol,side,entryPrice,exitPrice,quantity,accountId,pnl,openDate,closeDate,setupType,tradingSession,outcome,riskRewardRatio,stopLoss,takeProfit,tags,marketCondition,brokenRuleIds,mistakes,lessons,deletedAt,assetClass,contractMultiplier,updatedAt,fees,importSource',
      ExpressionAttributeNames: { '#u': 'userId', '#t': 'tradeId' },
      ExclusiveStartKey: lastEvaluatedKey,
    }));
    trades.push(...(resp.Items || []).filter((t: any) => !t.deletedAt));
    lastEvaluatedKey = resp.LastEvaluatedKey;
  } while (lastEvaluatedKey);
  return trades;
}

async function loadAccounts(userId: string): Promise<any[]> {
  let lastEvaluatedKey: any = undefined;
  const accounts: any[] = [];
  do {
    const resp: any = await ddb.send(new QueryCommand({
      TableName: ACCOUNTS_TABLE,
      KeyConditionExpression: 'userId = :u',
      ExpressionAttributeValues: { ':u': userId },
      ProjectionExpression: 'accountId, initialBalance, balance, tradeCount, lastTradeDate, updatedAt',
      ExclusiveStartKey: lastEvaluatedKey,
    }));
    accounts.push(...(resp.Items || []));
    lastEvaluatedKey = resp.LastEvaluatedKey;
  } while (lastEvaluatedKey);
  return accounts;
}

/**
 * Sets every account's balance to initialBalance + the P&L of its live trades, and its tradeCount and lastTradeDate to
 * those of the trades that have a real day (the ones DailyStats holds). A write only lands if the account is unchanged
 * since `accounts` was read (a stream ADD or an edit in between bumps updatedAt); returns how many did not. Any other
 * failure is thrown after every account was tried.
 */
async function updateBalances(userId: string, accounts: any[], trades: any[], timeZone: string | null): Promise<number> {
  const totals = new Map<string, { pnl: number; count: number; lastDay: string | null }>();
  for (const t of trades) {
    if (!isValidAccount(t.accountId)) continue;
    const total = totals.get(t.accountId) ?? { pnl: 0, count: 0, lastDay: null };
    const pnl = calcPnL(t);
    if (pnl != null) total.pnl += pnl;
    const day = dayOf(t.openDate, timeZone);
    if (day && isCalendarDay(day)) {
      total.count++;
      if (!total.lastDay || day > total.lastDay) total.lastDay = day;
    }
    totals.set(t.accountId, total);
  }

  let conflicts = 0;
  let failure: unknown;
  for (const account of accounts) {
    const total = totals.get(account.accountId);
    const newBalance = Math.round(((account.initialBalance || 0) + (total?.pnl || 0)) * 100) / 100;
    const count = total?.count ?? 0;
    const lastDay = total?.lastDay ?? null;
    if (account.balance === newBalance && account.tradeCount === count && (account.lastTradeDate ?? null) === lastDay) continue;
    try {
      await ddb.send(new UpdateCommand({
        TableName: ACCOUNTS_TABLE,
        Key: { userId, accountId: account.accountId },
        UpdateExpression: `SET #balance = :balance, #tradeCount = :count, #updatedAt = :updatedAt${lastDay ? ', #lastTradeDate = :lastDay' : ' REMOVE #lastTradeDate'}`,
        ConditionExpression: account.updatedAt === undefined ? 'attribute_not_exists(#updatedAt)' : '#updatedAt = :seen',
        ExpressionAttributeNames: { '#balance': 'balance', '#tradeCount': 'tradeCount', '#lastTradeDate': 'lastTradeDate', '#updatedAt': 'updatedAt' },
        ExpressionAttributeValues: {
          ':balance': newBalance,
          ':count': count,
          ':updatedAt': new Date().toISOString(),
          ...(lastDay ? { ':lastDay': lastDay } : {}),
          ...(account.updatedAt === undefined ? {} : { ':seen': account.updatedAt }),
        },
      }));
    } catch (e: any) {
      if (e.name === 'ConditionalCheckFailedException') conflicts++;
      else {
        console.error(`Failed to update balance for account ${account.accountId}`, e);
        failure ??= e;
      }
    }
  }
  if (failure) throw failure;
  return conflicts;
}

/**
 * Rebuilds a user's balances and daily stats from their trades. Daily records whose tradeHash is unchanged are left
 * alone; `force` rewrites them all (needed when the time zone changed, which moves hours and days but not the hash).
 */
export async function rebuildForUser(userId: string, opts: { force?: boolean } = {}): Promise<void> {
  const timeZone = await getUserTimeZone(userId).catch(() => null);

  // Daily stats are rebuilt even when the balances cannot be settled; the user then stays flagged and is retried.
  let trades: any[] = [];
  let balanceFailure: unknown;
  for (let attempt = 1; attempt <= BALANCE_ATTEMPTS; attempt++) {
    const accounts = await loadAccounts(userId);
    trades = await loadTrades(userId);
    try {
      if ((await updateBalances(userId, accounts, trades, timeZone)) === 0) {
        balanceFailure = undefined;
        break;
      }
      balanceFailure = new Error(`balances of ${userId} kept changing`);
    } catch (e) {
      balanceFailure = e;
      break;
    }
  }

  // --- Rebuild DailyStatsTable ---
  // Group trades by (accountId, date)
  const dailyGroups = new Map<string, any[]>();
  for (const t of trades) {
    const accountId = t.accountId;
    if (!isValidAccount(accountId)) continue;
    const date = dayOf(t.openDate, timeZone);
    if (!date || !isCalendarDay(date)) continue;
    const key = `${accountId}#${date}`;
    const group = dailyGroups.get(key);
    if (group) { group.push(t); } else { dailyGroups.set(key, [t]); }
  }

  const storedHashes = new Map<string, string | undefined>();
  let dailyLastKey: any = undefined;
  do {
    const queryResp: any = await ddb.send(new QueryCommand({
      TableName: DAILY_STATS_TABLE,
      KeyConditionExpression: 'userId = :uid',
      ExpressionAttributeValues: { ':uid': userId },
      ProjectionExpression: 'userId, sk, tradeHash',
      ExclusiveStartKey: dailyLastKey,
    }));
    for (const item of queryResp.Items || []) storedHashes.set(item.sk, item.tradeHash);
    dailyLastKey = queryResp.LastEvaluatedKey;
  } while (dailyLastKey);

  const records: any[] = [];
  for (const [key, groupTrades] of dailyGroups) {
    const [accountId, date] = key.split('#');
    const record = computeDailyRecord(userId, accountId, date, groupTrades, timeZone);
    if (record) records.push(record);
  }

  await batchWritePutAll({
    ddb,
    tableName: DAILY_STATS_TABLE,
    items: records.filter((r) => opts.force || storedHashes.get(r.sk) !== r.tradeHash),
  });

  // Orphan cleanup: delete daily stats records that no longer have trades
  const liveSks = new Set(records.map((r) => r.sk));
  await batchWriteDeleteAll({
    ddb,
    tableName: DAILY_STATS_TABLE,
    keys: [...storedHashes.keys()].filter((sk) => !liveSks.has(sk)).map((sk) => ({ userId, sk })),
  });

  if (balanceFailure) throw balanceFailure;
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

// Periodic job: rebuild stats, account balances, and daily stats for the users
// update-stats flagged as changed since their last rebuild.
export const handler = async () => {
  console.log('rebuild-stats-job started', { timestamp: new Date().toISOString() });

  const dirtyUsers = await getDirtyUsers();

  if (dirtyUsers.length === 0) {
    return { rebuiltUsers: 0, skipped: 'no recent changes' };
  }

  // Warn if unusually high — but process ALL users, never skip
  if (dirtyUsers.length > WARN_THRESHOLD) {
    console.warn(`rebuild-stats-job: ${dirtyUsers.length} users need rebuilding (above ${WARN_THRESHOLD} threshold)`);
  }

  // Process 5 users concurrently — each user's rebuild is independent (different partition key)
  const CONCURRENT_USERS = 5;
  const allErrors: Error[] = [];
  for (let i = 0; i < dirtyUsers.length; i += CONCURRENT_USERS) {
    const batch = dirtyUsers.slice(i, i + CONCURRENT_USERS);
    const results = await Promise.allSettled(
      batch.map(async ({ userId, dirtyAt }) => {
        await rebuildForUser(userId);
        await clearDirty(userId, dirtyAt);
      })
    );
    for (const result of results) {
      if (result.status === 'rejected') {
        allErrors.push(result.reason);
      }
    }
  }

  // Re-throw the first error so callers (and tests) see the failure; failed users stay flagged for the next run
  if (allErrors.length > 0) {
    throw allErrors[0];
  }

  return { rebuiltUsers: dirtyUsers.length };
};
