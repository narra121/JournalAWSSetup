import { DynamoDBStreamHandler, DynamoDBStreamEvent } from 'aws-lambda';
import { unmarshall } from '@aws-sdk/util-dynamodb';
import { ddb } from '../../shared/dynamo';
import { BatchGetCommand, GetCommand, PutCommand, QueryCommand, UpdateCommand, DeleteCommand } from '@aws-sdk/lib-dynamodb';
import { computeDailyRecord } from '../../shared/stats-aggregator';
import { extractDate, calcPnL } from '../../shared/utils/pnl';

const TRADES_TABLE = process.env.TRADES_TABLE!;
const DAILY_STATS_TABLE = process.env.DAILY_STATS_TABLE!;
const ACCOUNTS_TABLE = process.env.ACCOUNTS_TABLE!;
const SAVED_OPTIONS_TABLE = process.env.SAVED_OPTIONS_TABLE!;

// ---------------------------------------------------------------------------
// Query helpers
// ---------------------------------------------------------------------------

/**
 * Fetch all trades for a given (userId, accountId, date) from the GSI.
 * GSI is KEYS_ONLY — query for keys, then BatchGet full records.
 */
async function queryTradesForDay(userId: string, accountId: string, date: string): Promise<any[]> {
  const gsiResult = await ddb.send(new QueryCommand({
    TableName: TRADES_TABLE,
    IndexName: 'trades-by-date-gsi',
    KeyConditionExpression: 'userId = :u AND begins_with(openDate, :d)',
    ExpressionAttributeValues: { ':u': userId, ':d': date },
  }));
  const gsiItems = gsiResult.Items || [];
  if (gsiItems.length === 0) return [];

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

  return fullItems.filter((it: any) => it.accountId === accountId);
}

// ---------------------------------------------------------------------------
// Incremental account balance update
// ---------------------------------------------------------------------------

/**
 * Apply a PnL delta to an account's balance using atomic ADD.
 * This is O(1) — no scanning, no reading all trades.
 *
 * For safety, uses ADD which is idempotent in the sense that if the stream
 * event is retried, the same delta is applied again. The scheduled
 * rebuild-stats-job corrects any drift periodically.
 */
async function adjustAccountBalance(userId: string, accountId: string, pnlDelta: number): Promise<void> {
  if (!accountId || accountId === '-1' || String(accountId) === '-1') return;
  if (pnlDelta === 0) return;

  try {
    await ddb.send(new UpdateCommand({
      TableName: ACCOUNTS_TABLE,
      Key: { userId, accountId },
      UpdateExpression: 'ADD #balance :delta SET #updatedAt = :now',
      ExpressionAttributeNames: { '#balance': 'balance', '#updatedAt': 'updatedAt' },
      ExpressionAttributeValues: {
        ':delta': Math.round(pnlDelta * 100) / 100,
        ':now': new Date().toISOString(),
      },
      // Only update if the account exists
      ConditionExpression: 'attribute_exists(userId)',
    }));
  } catch (e: any) {
    // ConditionalCheckFailedException means account doesn't exist — safe to ignore
    if (e.name !== 'ConditionalCheckFailedException') {
      console.error(`Failed to adjust balance for account ${accountId} by ${pnlDelta}`, e);
    }
  }
}

// ---------------------------------------------------------------------------
// Sync trade symbols into SavedOptions
// ---------------------------------------------------------------------------

/**
 * Merge newly-seen symbols into the user's SavedOptions record.
 * Read-modify-write is acceptable here because stream events are low-frequency
 * and the periodic rebuild-stats-job can correct any drift.
 */
async function syncSymbolsToSavedOptions(userId: string, newSymbols: Set<string>): Promise<void> {
  if (newSymbols.size === 0) return;

  try {
    const existing = await ddb.send(new GetCommand({
      TableName: SAVED_OPTIONS_TABLE,
      Key: { userId },
      ProjectionExpression: 'symbols',
    }));

    const currentSymbols: string[] = existing.Item?.symbols || [];
    const currentSet = new Set(currentSymbols);
    const toAdd = [...newSymbols].filter(s => !currentSet.has(s));

    if (toAdd.length === 0) return;

    const merged = [...currentSymbols, ...toAdd];

    await ddb.send(new UpdateCommand({
      TableName: SAVED_OPTIONS_TABLE,
      Key: { userId },
      UpdateExpression: 'SET #symbols = :symbols, #updatedAt = :now',
      ExpressionAttributeNames: { '#symbols': 'symbols', '#updatedAt': 'updatedAt' },
      ExpressionAttributeValues: {
        ':symbols': merged,
        ':now': new Date().toISOString(),
      },
    }));
  } catch (e) {
    // Non-critical — don't fail the stream processing for a symbol sync issue
    console.error(`Failed to sync symbols for user ${userId}`, e);
  }
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export const handler: DynamoDBStreamHandler = async (event: DynamoDBStreamEvent) => {
  const failures: { itemIdentifier: string }[] = [];

  try {
    // 1. Detect affected (userId, accountId, date) tuples from stream records
    //    and compute per-account PnL deltas for incremental balance updates
    const affectedDays = new Map<string, Set<string>>(); // "userId#accountId" → Set<date>
    const balanceDeltas = new Map<string, number>(); // "userId#accountId" → pnlDelta
    const symbolsByUser = new Map<string, Set<string>>(); // userId → Set<symbol>

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

      const newPnl = newImage ? (calcPnL(newImage) ?? 0) : 0;
      const oldPnl = oldImage ? (calcPnL(oldImage) ?? 0) : 0;
      const newAcct = newImage?.accountId;
      const oldAcct = oldImage?.accountId;
      const isValidAcct = (a: any) => a && a !== '-1' && String(a) !== '-1';

      // --- Collect symbols for SavedOptions sync ---
      if (record.eventName === 'INSERT' || record.eventName === 'MODIFY') {
        const symbol = newImage?.symbol;
        if (symbol && typeof symbol === 'string') {
          if (!symbolsByUser.has(userId)) symbolsByUser.set(userId, new Set());
          symbolsByUser.get(userId)!.add(symbol);
        }
      }

      // --- Track affected days for DailyStats rebuild ---
      if (isValidAcct(newAcct)) {
        const date = extractDate(newImage!.openDate);
        if (date) {
          const key = `${userId}#${newAcct}`;
          if (!affectedDays.has(key)) affectedDays.set(key, new Set());
          affectedDays.get(key)!.add(date);
        }
      }
      if (isValidAcct(oldAcct)) {
        const date = extractDate(oldImage!.openDate);
        if (date) {
          const key = `${userId}#${oldAcct}`;
          if (!affectedDays.has(key)) affectedDays.set(key, new Set());
          affectedDays.get(key)!.add(date);
        }
      }

      // --- Compute balance deltas (incremental) ---
      if (record.eventName === 'INSERT') {
        // New trade: add its PnL
        if (isValidAcct(newAcct)) {
          const key = `${userId}#${newAcct}`;
          balanceDeltas.set(key, (balanceDeltas.get(key) || 0) + newPnl);
        }
      } else if (record.eventName === 'REMOVE') {
        // Deleted trade: subtract its PnL
        if (isValidAcct(oldAcct)) {
          const key = `${userId}#${oldAcct}`;
          balanceDeltas.set(key, (balanceDeltas.get(key) || 0) - oldPnl);
        }
      } else if (record.eventName === 'MODIFY') {
        // Updated trade: handle account change and/or PnL change
        if (oldAcct === newAcct && isValidAcct(newAcct)) {
          // Same account — apply PnL diff
          const delta = newPnl - oldPnl;
          if (delta !== 0) {
            const key = `${userId}#${newAcct}`;
            balanceDeltas.set(key, (balanceDeltas.get(key) || 0) + delta);
          }
        } else {
          // Account changed — subtract from old, add to new
          if (isValidAcct(oldAcct)) {
            const key = `${userId}#${oldAcct}`;
            balanceDeltas.set(key, (balanceDeltas.get(key) || 0) - oldPnl);
          }
          if (isValidAcct(newAcct)) {
            const key = `${userId}#${newAcct}`;
            balanceDeltas.set(key, (balanceDeltas.get(key) || 0) + newPnl);
          }
        }
      }
    }

    // 2. Rebuild only the affected daily records in DailyStatsTable
    for (const [userAccKey, dates] of affectedDays) {
      const [userId, accountId] = userAccKey.split('#', 2);

      for (const date of dates) {
        const trades = await queryTradesForDay(userId, accountId, date);

        if (trades.length === 0) {
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

    // 3. Apply incremental balance deltas (O(1) per account, no full scan)
    for (const [userAccKey, delta] of balanceDeltas) {
      const [userId, accountId] = userAccKey.split('#', 2);
      await adjustAccountBalance(userId, accountId, delta);
    }

    // 4. Sync new symbols into SavedOptions (non-blocking per user)
    for (const [userId, symbols] of symbolsByUser) {
      await syncSymbolsToSavedOptions(userId, symbols);
    }
  } catch (e) {
    console.error('Failed processing stream event', e);
    for (const record of event.Records) {
      if (record.eventID) {
        failures.push({ itemIdentifier: record.eventID });
      }
    }
  }

  return { batchItemFailures: failures };
};
