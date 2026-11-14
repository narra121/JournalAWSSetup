import { removeImagesForTrade } from '../../shared/images';
import { DynamoDBStreamHandler, DynamoDBStreamEvent } from 'aws-lambda';
import { unmarshall } from '@aws-sdk/util-dynamodb';
import { ddb } from '../../shared/dynamo';
import { GetCommand, PutCommand, QueryCommand, UpdateCommand, DeleteCommand } from '@aws-sdk/lib-dynamodb';
import { computeDailyRecord } from '../../shared/stats-aggregator';
import { calcPnL } from '../../shared/utils/pnl';
import { dayOf, dayQueryRange, getUserTimeZone, isCalendarDay } from '../../shared/timezone';
import { markStatsDirty } from '../../shared/statsDirty';
import { latestTradeDay } from '../../shared/dailyStats';
import { loadFullRecords } from '../../shared/tradeRecords';

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
  const { start, end } = dayQueryRange(date, timeZone);
  const gsiItems: any[] = [];
  let lastKey: Record<string, any> | undefined;
  do {
    const gsiResult = await ddb.send(new QueryCommand({
      TableName: TRADES_TABLE,
      IndexName: 'trades-by-date-gsi',
      KeyConditionExpression: 'userId = :u AND openDate BETWEEN :start AND :end',
      ExpressionAttributeValues: { ':u': userId, ':start': start, ':end': end },
      ExclusiveStartKey: lastKey,
    }));
    gsiItems.push(...(gsiResult.Items || []));
    lastKey = gsiResult.LastEvaluatedKey;
  } while (lastKey);
  if (gsiItems.length === 0) return [];

  // Throws when a record cannot be loaded: a day built from part of its trades must not be written.
  const full = await loadFullRecords(userId, gsiItems);
  return [...full.values()].filter((it: any) => it.accountId === accountId && !it.deletedAt && dayOf(it.openDate, timeZone) === date);
}

// ---------------------------------------------------------------------------
// Incremental account balance and trade count
// ---------------------------------------------------------------------------

const isValidAcct = (a: any) => a && a !== '-1' && String(a) !== '-1';

/**
 * True while the account is stored. A trade removed from a missing account belongs to a deleted account or user: its
 * day is deleted, not rebuilt, and the user is not flagged, so a purge is not undone by its own stream records.
 */
async function accountExists(userId: string, accountId: string): Promise<boolean> {
  const res = await ddb.send(new GetCommand({ TableName: ACCOUNTS_TABLE, Key: { userId, accountId }, ProjectionExpression: 'accountId' }));
  return !!res.Item;
}

/**
 * Apply a P&L delta and a trade-count delta to an account with atomic ADDs (O(1), no trade scan), and set its last
 * trade day when `refreshLastDay`. ADD is not idempotent: callers pass only deltas of records Lambda will not redeliver.
 * A failed ADD is logged and left for rebuild-stats-job to correct. An account without `tradeCount` (created before the
 * counters) only gets its balance: an ADD would start the count at the delta, so rebuild-stats-job or list-accounts
 * sets it absolutely.
 */
async function adjustAccount(userId: string, accountId: string, pnlDelta: number, countDelta: number, refreshLastDay: boolean): Promise<void> {
  if (!isValidAcct(accountId)) return;
  const delta = Math.round(pnlDelta * 100) / 100;
  if (delta === 0 && countDelta === 0 && !refreshLastDay) return;

  try {
    const lastDay = refreshLastDay ? await latestTradeDay(userId, accountId) : undefined;
    const now = new Date().toISOString();
    const names: Record<string, string> = { '#balance': 'balance', '#updatedAt': 'updatedAt', '#tradeCount': 'tradeCount' };
    const values: Record<string, any> = { ':delta': delta, ':count': countDelta, ':now': now };
    let set = '#updatedAt = :now';
    let remove = '';
    if (lastDay) {
      names['#lastTradeDate'] = 'lastTradeDate';
      values[':lastDay'] = lastDay;
      set += ', #lastTradeDate = :lastDay';
    } else if (lastDay === null) {
      names['#lastTradeDate'] = 'lastTradeDate';
      remove = ' REMOVE #lastTradeDate';
    }
    try {
      await ddb.send(new UpdateCommand({
        TableName: ACCOUNTS_TABLE,
        Key: { userId, accountId },
        UpdateExpression: `ADD #balance :delta, #tradeCount :count SET ${set}${remove}`,
        ConditionExpression: 'attribute_exists(#tradeCount)',
        ExpressionAttributeNames: names,
        ExpressionAttributeValues: values,
      }));
    } catch (e: any) {
      if (e.name !== 'ConditionalCheckFailedException') throw e;
      await ddb.send(new UpdateCommand({
        TableName: ACCOUNTS_TABLE,
        Key: { userId, accountId },
        UpdateExpression: 'ADD #balance :delta SET #updatedAt = :now',
        ConditionExpression: 'attribute_exists(userId)',
        ExpressionAttributeNames: { '#balance': 'balance', '#updatedAt': 'updatedAt' },
        ExpressionAttributeValues: { ':delta': delta, ':now': now },
      }));
    }
  } catch (e: any) {
    // ConditionalCheckFailedException means account doesn't exist — safe to ignore
    if (e.name !== 'ConditionalCheckFailedException') {
      console.error(`Failed to adjust account ${accountId} (balance ${pnlDelta}, trades ${countDelta})`, e);
    }
  }
}

// ---------------------------------------------------------------------------
// Sync trade symbols into SavedOptions
// ---------------------------------------------------------------------------

/** A user's saved symbol list stops growing here; the symbols of trades are still stored on the trades. */
const MAX_SAVED_SYMBOLS = 500;

/**
 * Append newly-seen symbols to the user's SavedOptions record, one conditional append per symbol: it only happens while
 * the symbol is not in the list and the list is under the cap, so a concurrent edit of the list or a second stream
 * invocation can neither lose a symbol nor add it twice.
 */
async function syncSymbolsToSavedOptions(userId: string, newSymbols: Set<string>): Promise<void> {
  for (const symbol of newSymbols) {
    try {
      await ddb.send(new UpdateCommand({
        TableName: SAVED_OPTIONS_TABLE,
        Key: { userId },
        UpdateExpression: 'SET #symbols = list_append(if_not_exists(#symbols, :empty), :one), #updatedAt = :now',
        ConditionExpression: 'attribute_not_exists(#symbols) OR (NOT contains(#symbols, :symbol) AND size(#symbols) < :max)',
        ExpressionAttributeNames: { '#symbols': 'symbols', '#updatedAt': 'updatedAt' },
        ExpressionAttributeValues: {
          ':empty': [],
          ':one': [symbol],
          ':symbol': symbol,
          ':max': MAX_SAVED_SYMBOLS,
          ':now': new Date().toISOString(),
        },
      }));
    } catch (e: any) {
      // Already saved (or the list is full): nothing to do. Anything else is non-critical: don't fail the stream batch.
      if (e?.name !== 'ConditionalCheckFailedException') console.error(`Failed to sync symbol for user ${userId}`, e);
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
    //    and compute per-account PnL deltas for incremental balance updates
    const affectedDays = new Map<string, Set<string>>(); // "userId#accountId" → Set<date>
    const balanceEntries: { index: number; key: string; delta: number }[] = []; // key = "userId#accountId"
    // Trades entering or leaving an account's count; `moved` when the change can alter its last trade day.
    const tradeEntries: { index: number; key: string; count: number; moved: boolean }[] = [];
    const writtenKeys = new Set<string>(); // "userId#accountId" touched by an INSERT or MODIFY
    const removedKeys = new Set<string>(); // "userId#accountId" touched by a REMOVE
    const indexByEventId = new Map<string, number>(); // SequenceNumber → position in the batch
    const symbolsByUser = new Map<string, Set<string>>(); // userId → Set<symbol>
    const purgedTrades: { userId: string; tradeId: string }[] = []; // soft-deleted trades removed by TTL
    const tupleToEventIds = new Map<string, Set<string>>(); // "userId#accountId#date" → Set<eventID>
    const zones = new Map<string, string | null>(); // userId → IANA time zone preference
    const zoneOf = async (userId: string): Promise<string | null> => {
      if (!zones.has(userId)) zones.set(userId, await getUserTimeZone(userId).catch(() => null));
      return zones.get(userId) ?? null;
    };

    for (const [index, record] of event.Records.entries()) {
      if (!record.dynamodb) continue;
      if (record.dynamodb.SequenceNumber) indexByEventId.set(record.dynamodb.SequenceNumber, index);

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
        if (date && isCalendarDay(date)) {
          const key = `${userId}#${newAcct}`;
          if (!affectedDays.has(key)) affectedDays.set(key, new Set());
          affectedDays.get(key)!.add(date);
          writtenKeys.add(key);
          const tupleKey = `${userId}#${newAcct}#${date}`;
          if (!tupleToEventIds.has(tupleKey)) tupleToEventIds.set(tupleKey, new Set());
          if (eventId) tupleToEventIds.get(tupleKey)!.add(eventId);
        }
      }
      if (isValidAcct(oldAcct)) {
        const date = dayOf(oldImage!.openDate, tz);
        if (date && isCalendarDay(date)) {
          const key = `${userId}#${oldAcct}`;
          if (!affectedDays.has(key)) affectedDays.set(key, new Set());
          affectedDays.get(key)!.add(date);
          (record.eventName === 'REMOVE' ? removedKeys : writtenKeys).add(key);
          const tupleKey = `${userId}#${oldAcct}#${date}`;
          if (!tupleToEventIds.has(tupleKey)) tupleToEventIds.set(tupleKey, new Set());
          if (eventId) tupleToEventIds.get(tupleKey)!.add(eventId);
        }
      }

      // --- Compute balance deltas (incremental) ---
      if (effectiveEvent === 'INSERT') {
        // New (or restored) trade: add its PnL
        if (isValidAcct(liveNewAcct)) {
          balanceEntries.push({ index, key: `${userId}#${liveNewAcct}`, delta: newPnl });
        }
      } else if (effectiveEvent === 'REMOVE') {
        // Deleted (or soft-deleted) trade: subtract its PnL
        if (isValidAcct(liveOldAcct)) {
          balanceEntries.push({ index, key: `${userId}#${liveOldAcct}`, delta: -oldPnl });
        }
      } else if (effectiveEvent === 'MODIFY') {
        // Updated trade: handle account change and/or PnL change
        if (liveOldAcct === liveNewAcct && isValidAcct(liveNewAcct)) {
          // Same account — apply PnL diff
          const delta = newPnl - oldPnl;
          if (delta !== 0) {
            balanceEntries.push({ index, key: `${userId}#${newAcct}`, delta });
          }
        } else {
          // Account changed — subtract from old, add to new
          if (isValidAcct(oldAcct)) {
            balanceEntries.push({ index, key: `${userId}#${oldAcct}`, delta: -oldPnl });
          }
          if (isValidAcct(newAcct)) {
            balanceEntries.push({ index, key: `${userId}#${newAcct}`, delta: newPnl });
          }
        }
      }

      // --- Trade count: a trade counts while live, in a real account, on a real day (as DailyStats counts it) ---
      const counted = (image: Record<string, any> | null) => {
        if (!image || image.deletedAt || !isValidAcct(image.accountId)) return null;
        const day = dayOf(image.openDate, tz);
        return isCalendarDay(day) ? { key: `${userId}#${image.accountId}`, day } : null;
      };
      const was = counted(oldImage);
      const is = counted(newImage);
      const moved = was?.key !== is?.key || was?.day !== is?.day;
      if (was) tradeEntries.push({ index, key: was.key, count: -1, moved });
      if (is) tradeEntries.push({ index, key: is.key, count: 1, moved });
    }

    // Accounts whose every trade change in this batch is a removal and that are no longer stored.
    const goneAccounts = new Set<string>();
    for (const key of removedKeys) {
      if (writtenKeys.has(key)) continue;
      const [userId, accountId] = key.split('#', 2);
      if (!(await accountExists(userId, accountId))) goneAccounts.add(key);
    }

    // Flag the users for the next rebuild-stats-job run; best effort, the affected days are rebuilt right below.
    await Promise.all([...new Set([...affectedDays.keys()].filter((k) => !goneAccounts.has(k)).map((k) => k.split('#', 1)[0]))].map((userId) =>
      markStatsDirty(ddb, DAILY_STATS_TABLE, userId).catch((e) => console.error(`Failed to flag ${userId} for rebuild`, e))));

    // 2. Rebuild only the affected daily records in DailyStatsTable
    const tupleFailures: string[] = [];
    for (const [userAccKey, dates] of affectedDays) {
      const [userId, accountId] = userAccKey.split('#', 2);

      for (const date of dates) {
        try {
          const tz = await zoneOf(userId);
          const trades = goneAccounts.has(userAccKey) ? [] : await queryTradesForDay(userId, accountId, date, tz);

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

    // 3. Apply incremental balance and trade-count deltas (O(1) per account, no full scan). Lambda redelivers every
    //    record from the first reported failure onward, so only records before it are final; the rest are applied by
    //    the redelivery.
    const firstFailedIndex = Math.min(
      Infinity,
      ...failures.map(f => indexByEventId.get(f.itemIdentifier) ?? Infinity),
    );
    const changes = new Map<string, { pnl: number; count: number; moved: boolean }>();
    const change = (key: string) => {
      if (!changes.has(key)) changes.set(key, { pnl: 0, count: 0, moved: false });
      return changes.get(key)!;
    };
    for (const { index, key, delta } of balanceEntries) {
      if (index < firstFailedIndex && !goneAccounts.has(key)) change(key).pnl += delta;
    }
    for (const { index, key, count, moved } of tradeEntries) {
      if (index >= firstFailedIndex || goneAccounts.has(key)) continue;
      change(key).count += count;
      change(key).moved ||= moved;
    }
    for (const [userAccKey, { pnl, count, moved }] of changes) {
      const [userId, accountId] = userAccKey.split('#', 2);
      await adjustAccount(userId, accountId, pnl, count, moved);
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
