import { DynamoDBStreamHandler, DynamoDBStreamEvent } from 'aws-lambda';
import { unmarshall } from '@aws-sdk/util-dynamodb';
import { ddb } from '../../shared/dynamo';
import { BatchGetCommand, GetCommand, PutCommand, QueryCommand, UpdateCommand, DeleteCommand } from '@aws-sdk/lib-dynamodb';
import { computeDailyRecord } from '../../shared/stats-aggregator';
import { extractDate, calcPnL } from '../../shared/utils/pnl';

const TRADES_TABLE = process.env.TRADES_TABLE!;
const DAILY_STATS_TABLE = process.env.DAILY_STATS_TABLE!;
const ACCOUNTS_TABLE = process.env.ACCOUNTS_TABLE!;

// ---------------------------------------------------------------------------
// Query helpers
// ---------------------------------------------------------------------------

/**
 * Fetch all trades for a given (userId, accountId, date) from the GSI.
 */
async function queryTradesForDay(userId: string, accountId: string, date: string): Promise<any[]> {
  // GSI is KEYS_ONLY — query GSI for keys, then BatchGet full records from main table
  const gsiResult = await ddb.send(new QueryCommand({
    TableName: TRADES_TABLE,
    IndexName: 'trades-by-date-gsi',
    KeyConditionExpression: 'userId = :u AND begins_with(openDate, :d)',
    ExpressionAttributeValues: { ':u': userId, ':d': date },
  }));
  const gsiItems = gsiResult.Items || [];
  if (gsiItems.length === 0) return [];

  // Fetch full records from main table
  const keys = gsiItems.map((it: any) => ({ userId: it.userId, tradeId: it.tradeId }));
  const fullItems: any[] = [];
  for (let i = 0; i < keys.length; i += 100) {
    const chunk = keys.slice(i, i + 100);
    const batchResult = await ddb.send(new BatchGetCommand({
      RequestItems: { [TRADES_TABLE]: { Keys: chunk } },
    }));
    if (batchResult.Responses?.[TRADES_TABLE]) {
      fullItems.push(...batchResult.Responses[TRADES_TABLE]);
    }
  }

  // Filter by accountId (now we have the full record with accountId)
  return fullItems.filter((it: any) => it.accountId === accountId);
}

// ---------------------------------------------------------------------------
// Legacy full-rebuild for dual-write to old STATS_TABLE + account balances
// ---------------------------------------------------------------------------

/** Fields needed by calcPnL + accountId for per-account aggregation */
const STATS_PROJECTION = 'pnl, side, entryPrice, exitPrice, quantity, accountId';

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
      TableName: TRADES_TABLE,
      KeyConditionExpression: 'userId = :u',
      ExpressionAttributeValues: { ':u': userId },
      ProjectionExpression: STATS_PROJECTION,
      ExclusiveStartKey: lastEvaluatedKey,
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

  if (tradeCount > 10_000) {
    console.warn(
      `[rebuildStats] userId=${userId} has ${tradeCount} trades — ` +
      'consider migrating to incremental stats to avoid high read consumption',
    );
  }

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
        ExpressionAttributeValues: {
          ':balance': Math.round(newBalance * 100) / 100,
          ':updatedAt': new Date().toISOString(),
        },
      }));
    } catch (e) {
      console.error(`Failed to update balance for account ${accountId}`, e);
    }
  }
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export const handler: DynamoDBStreamHandler = async (event: DynamoDBStreamEvent) => {
  const failures: { itemIdentifier: string }[] = [];

  try {
    // 1. Detect affected (userId, accountId, date) tuples from stream records
    // Map<"userId#accountId", Set<date>>
    const affectedDays = new Map<string, Set<string>>();

    for (const record of event.Records) {
      if (!record.dynamodb) continue;

      const newImage = record.dynamodb.NewImage
        ? unmarshall(record.dynamodb.NewImage as Record<string, any>)
        : null;
      const oldImage = record.dynamodb.OldImage
        ? unmarshall(record.dynamodb.OldImage as Record<string, any>)
        : null;
      const userId = newImage?.userId || oldImage?.userId;
      if (!userId) continue;

      // From NEW image (INSERT or MODIFY)
      if (newImage?.accountId && newImage.accountId !== '-1' && String(newImage.accountId) !== '-1') {
        const date = extractDate(newImage.openDate);
        if (date) {
          const key = `${userId}#${newImage.accountId}`;
          if (!affectedDays.has(key)) affectedDays.set(key, new Set());
          affectedDays.get(key)!.add(date);
        }
      }

      // From OLD image (MODIFY date/account change, or REMOVE)
      if (oldImage?.accountId && oldImage.accountId !== '-1' && String(oldImage.accountId) !== '-1') {
        const date = extractDate(oldImage.openDate);
        if (date) {
          const key = `${userId}#${oldImage.accountId}`;
          if (!affectedDays.has(key)) affectedDays.set(key, new Set());
          affectedDays.get(key)!.add(date);
        }
      }
    }

    // 2. Rebuild only the affected daily records in DailyStatsTable
    const affectedAccountIds = new Set<string>(); // for account balance update

    for (const [userAccKey, dates] of affectedDays) {
      const [userId, accountId] = userAccKey.split('#', 2);
      affectedAccountIds.add(userAccKey); // track for balance update

      for (const date of dates) {
        // Query all trades for this user on this date with this accountId
        const trades = await queryTradesForDay(userId, accountId, date);

        if (trades.length === 0) {
          // Delete daily stats record — no trades left for this day
          await ddb.send(new DeleteCommand({
            TableName: DAILY_STATS_TABLE,
            Key: { userId, sk: `${accountId}#${date}` },
          }));
        } else {
          const record = computeDailyRecord(userId, accountId, date, trades);
          if (record) {
            await ddb.send(new PutCommand({
              TableName: DAILY_STATS_TABLE,
              Item: record,
            }));
          }
        }
      }
    }

    // 3. Dual-write: rebuild old stats table + account balances per affected user
    const affectedUserIds = new Set<string>();
    for (const userAccKey of affectedDays.keys()) {
      const [userId] = userAccKey.split('#', 2);
      affectedUserIds.add(userId);
    }

    for (const userId of affectedUserIds) {
      await rebuildStats(userId);
    }
  } catch (e) {
    console.error('Failed processing stream event', e);
    // Mark all records as failed so they are retried
    for (const record of event.Records) {
      if (record.eventID) {
        failures.push({ itemIdentifier: record.eventID });
      }
    }
  }

  return { batchItemFailures: failures };
};
