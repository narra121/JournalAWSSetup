import { removeImagesForTrade } from '../../shared/images';
import { DynamoDBStreamHandler, DynamoDBStreamEvent } from 'aws-lambda';
import { unmarshall } from '@aws-sdk/util-dynamodb';
import { ddb } from '../../shared/dynamo';
import { BatchGetCommand, GetCommand, PutCommand, QueryCommand, UpdateCommand, DeleteCommand } from '@aws-sdk/lib-dynamodb';
import { computeDailyRecord } from '../../shared/stats-aggregator';
import { calcPnL } from '../../shared/utils/pnl';
import { dayOf, dayRangeUtc, getUserTimeZone } from '../../shared/timezone';

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
async function queryTradesForDay(userId: string, accountId: string, date: string, timeZone?: string | null): Promise<any[]> {
  // The day is a calendar day in the user's zone, i.e. an exact UTC range of openDate values.
  const { start, end } = dayRangeUtc(date, timeZone);
  const gsiResult = await ddb.send(new QueryCommand({
    TableName: TRADES_TABLE,
    IndexName: 'trades-by-date-gsi',
    KeyConditionExpression: 'userId = :u AND openDate BETWEEN :start AND :end',
    ExpressionAttributeValues: { ':u': userId, ':start': start, ':end': end },
  }));
  const gsiItems = gsiResult.Items || [];
  if (gsiItems.length === 0) return [];

  const keys = gsiItems.map((it: any) => ({ userId: it.userId, tradeId: it.tradeId }));
  const fullItems: any[] = [];
  for (let i = 0; i < keys.length; i += 100) {
    let chunk = keys.slice(i, i + 100);
    for (let attempt = 0; attempt < 3 && chunk.length > 0; attempt++) {
      const batchResult = await ddb.send(new BatchGetCommand({
        RequestItems: { [TRADES_TABLE]: { Keys: chunk } },
      }));
      if (batchResult.Responses?.[TRADES_TABLE]) {
        fullItems.push(...batchResult.Responses[TRADES_TABLE]);
      }
      const unprocessed = batchResult.UnprocessedKeys?.[TRADES_TABLE]?.Keys;
      if (!unprocessed || unprocessed.length === 0) break;
      chunk = unprocessed as any[];
      if (attempt < 2) {
        await new Promise(resolve => setTimeout(resolve, 50 * Math.pow(2, attempt)));
      }
    }
  }

  return fullItems.filter((it: any) => it.accountId === accountId && !it.deletedAt && dayOf(it.openDate, timeZone) === date);
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
    const purgedTrades: { userId: string; tradeId: string }[] = []; // soft-deleted trades removed by TTL
    const tupleToEventIds = new Map<string, Set<string>>(); // "userId#accountId#date" → Set<eventID>
    const zones = new Map<string, string | null>(); // userId → IANA time zone preference
    const zoneOf = async (userId: string): Promise<string | null> => {
      if (!zones.has(userId)) zones.set(userId, await getUserTimeZone(userId).catch(() => null));
      return zones.get(userId) ?? null;
    };

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
      if (record.eventName === 'REMOVE' && oldImage?.deletedAt && oldImage.tradeId) {
        purgedTrades.push({ userId, tradeId: oldImage.tradeId });
      }

      // A soft-deleted trade counts as removed for balances; restoring counts as an insert. Day records are rebuilt
      // from the table (which skips deleted trades), so the real images still decide which days to rebuild.
      const newLive = newImage && !newImage.deletedAt ? newImage : null;
      const oldLive = oldImage && !oldImage.deletedAt ? oldImage : null;
      const effectiveEvent = newLive && oldLive ? 'MODIFY' : newLive ? 'INSERT' : oldLive ? 'REMOVE' : 'NONE';
      const newPnl = newLive ? (calcPnL(newLive) ?? 0) : 0;
      const oldPnl = oldLive ? (calcPnL(oldLive) ?? 0) : 0;
      const newAcct = newImage?.accountId;
      const oldAcct = oldImage?.accountId;
      const liveNewAcct = newLive?.accountId;
      const liveOldAcct = oldLive?.accountId;
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
      const eventId = record.dynamodb.SequenceNumber || '';
      const tz = await zoneOf(userId);
      if (isValidAcct(newAcct)) {
        const date = dayOf(newImage!.openDate, tz);
        if (date) {
          const key = `${userId}#${newAcct}`;
          if (!affectedDays.has(key)) affectedDays.set(key, new Set());
          affectedDays.get(key)!.add(date);
          const tupleKey = `${userId}#${newAcct}#${date}`;
          if (!tupleToEventIds.has(tupleKey)) tupleToEventIds.set(tupleKey, new Set());
          if (eventId) tupleToEventIds.get(tupleKey)!.add(eventId);
        }
      }
      if (isValidAcct(oldAcct)) {
        const date = dayOf(oldImage!.openDate, tz);
        if (date) {
          const key = `${userId}#${oldAcct}`;
          if (!affectedDays.has(key)) affectedDays.set(key, new Set());
          affectedDays.get(key)!.add(date);
          const tupleKey = `${userId}#${oldAcct}#${date}`;
          if (!tupleToEventIds.has(tupleKey)) tupleToEventIds.set(tupleKey, new Set());
          if (eventId) tupleToEventIds.get(tupleKey)!.add(eventId);
        }
      }

      // --- Compute balance deltas (incremental) ---
      if (effectiveEvent === 'INSERT') {
        // New (or restored) trade: add its PnL
        if (isValidAcct(liveNewAcct)) {
          const key = `${userId}#${liveNewAcct}`;
          balanceDeltas.set(key, (balanceDeltas.get(key) || 0) + newPnl);
        }
      } else if (effectiveEvent === 'REMOVE') {
        // Deleted (or soft-deleted) trade: subtract its PnL
        if (isValidAcct(liveOldAcct)) {
          const key = `${userId}#${liveOldAcct}`;
          balanceDeltas.set(key, (balanceDeltas.get(key) || 0) - oldPnl);
        }
      } else if (effectiveEvent === 'MODIFY') {
        // Updated trade: handle account change and/or PnL change
        if (liveOldAcct === liveNewAcct && isValidAcct(liveNewAcct)) {
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
    const tupleFailures: string[] = [];
    for (const [userAccKey, dates] of affectedDays) {
      const [userId, accountId] = userAccKey.split('#', 2);

      for (const date of dates) {
        try {
          const tz = await zoneOf(userId);
          const trades = await queryTradesForDay(userId, accountId, date, tz);

          if (trades.length === 0) {
            await ddb.send(new DeleteCommand({
              TableName: DAILY_STATS_TABLE,
              Key: { userId, sk: `${accountId}#${date}` },
            }));
          } else {
            const record = computeDailyRecord(userId, accountId, date, trades, tz);
            if (record) {
              await ddb.send(new PutCommand({
                TableName: DAILY_STATS_TABLE,
                Item: record,
              }));
            }
          }
        } catch (tupleError) {
          console.error(`Failed processing tuple ${userId}/${accountId}/${date}`, tupleError);
          tupleFailures.push(`${userId}#${accountId}#${date}`);
        }
      }
    }

    // Mark failed tuples as batch item failures
    if (tupleFailures.length > 0) {
      const failedEventIds = new Set<string>();
      for (const tupleKey of tupleFailures) {
        const eventIds = tupleToEventIds.get(tupleKey);
        if (eventIds) {
          for (const eid of eventIds) failedEventIds.add(eid);
        }
      }
      for (const eid of failedEventIds) {
        failures.push({ itemIdentifier: eid });
      }
    }

    // 3. Apply incremental balance deltas (O(1) per account, no full scan)
    for (const [userAccKey, delta] of balanceDeltas) {
      const [userId, accountId] = userAccKey.split('#', 2);
      await adjustAccountBalance(userId, accountId, delta);
    }

    // 4. Non-critical parallel operations (each user is independent)
    //    - Sync new symbols into SavedOptions
    await Promise.allSettled([
      ...([...symbolsByUser].map(([userId, symbols]) =>
        syncSymbolsToSavedOptions(userId, symbols)
      )),
      // Screenshots of a trade whose 30-day restore window ended go with it.
      ...purgedTrades.map(({ userId, tradeId }) => removeImagesForTrade(userId, tradeId)),
    ]);
  } catch (e) {
    console.error('Failed processing stream event', e);
    for (const record of event.Records) {
      if (record.dynamodb?.SequenceNumber) {
        failures.push({ itemIdentifier: record.dynamodb?.SequenceNumber });
      }
    }
  }

  return { batchItemFailures: failures };
};
