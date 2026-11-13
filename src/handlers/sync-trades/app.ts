import type { ApiHandler } from '../../shared/types';
import { QueryCommand } from '@aws-sdk/lib-dynamodb';
import { ddb } from '../../shared/dynamo';
import { queryDailyStats } from '../../shared/dailyStats';
import { getUserId } from '../../shared/auth';
import { envelope, errorResponse, ErrorCodes } from '../../shared/validation';
import { DailyStatsRecord } from '../../shared/metrics/types';
import { createHash } from 'crypto';
import { dayOf, dayQueryRange, getUserTimeZone, isCalendarDay } from '../../shared/timezone';
import { IncompleteLoadError, loadFullRecords } from '../../shared/tradeRecords';

const TRADES_TABLE = process.env.TRADES_TABLE!;
const DAY_CONCURRENCY = 4;

interface SyncRequest {
  accountId: string;
  startDate: string;
  endDate: string;
  clientHashes: Record<string, string>;
}

export const handler: ApiHandler = async (event) => {
  const userId = getUserId(event);
  if (!userId) return errorResponse(401, ErrorCodes.UNAUTHORIZED, 'Unauthorized');

  let body: SyncRequest;
  try {
    body = JSON.parse(event.body || '{}');
  } catch {
    return errorResponse(400, ErrorCodes.VALIDATION_ERROR, 'Invalid JSON body');
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return errorResponse(400, ErrorCodes.VALIDATION_ERROR, 'Body must be a JSON object');

  const { accountId, startDate, endDate, clientHashes = {} } = body;

  if (!accountId || !startDate || !endDate) {
    return errorResponse(400, ErrorCodes.VALIDATION_ERROR, 'accountId, startDate, and endDate are required');
  }
  if (!isCalendarDay(startDate) || !isCalendarDay(endDate)) {
    return errorResponse(400, ErrorCodes.VALIDATION_ERROR, 'startDate and endDate must be dates in YYYY-MM-DD form');
  }

  try {
    const isAll = accountId === 'ALL';
    const records = await queryDailyStats(userId, accountId, startDate, endDate);

    const serverHashes: Record<string, string> = {};
    if (isAll) {
      const dateHashMap = new Map<string, string[]>();
      for (const rec of records) {
        if (!rec.tradeHash || !rec.date) continue;
        const existing = dateHashMap.get(rec.date) || [];
        existing.push(`${rec.accountId}:${rec.tradeHash}`);
        dateHashMap.set(rec.date, existing);
      }
      for (const [date, hashes] of dateHashMap) {
        hashes.sort();
        serverHashes[date] = createHash('sha256').update(hashes.join('||')).digest('hex');
      }
    } else {
      for (const rec of records) {
        if (rec.tradeHash && rec.date) {
          serverHashes[rec.date] = rec.tradeHash;
        }
      }
    }

    const allDates = new Set<string>([
      ...Object.keys(serverHashes),
      ...Object.keys(clientHashes),
    ]);
    const staleDays: string[] = [];
    for (const date of allDates) {
      if (date < startDate || date > endDate || !isCalendarDay(date)) continue;
      if (clientHashes[date] !== serverHashes[date]) {
        staleDays.push(date);
      }
    }
    staleDays.sort();

    // Trades come back grouped by the user's local day, the same day the hashes and stale days are keyed by. A stale day
    // missing from `tradesByDay` could not be loaded completely: its hash is withheld so the client fetches it again.
    const tradesByDay: Record<string, any[]> = {};
    if (staleDays.length > 0) {
      const timeZone = await getUserTimeZone(userId).catch(() => null);
      const account = isAll ? undefined : accountId;
      for (let i = 0; i < staleDays.length; i += DAY_CONCURRENCY) {
        await Promise.all(staleDays.slice(i, i + DAY_CONCURRENCY).map(async (day) => {
          try {
            tradesByDay[day] = await fetchTradesForDay(userId, account, day, timeZone);
          } catch (e) {
            if (!(e instanceof IncompleteLoadError)) throw e;
            console.warn('Sync day incomplete', { userId, day });
            delete serverHashes[day];
          }
        }));
      }
    }

    return envelope({
      statusCode: 200,
      data: { serverHashes, staleDays, tradesByDay },
      message: 'Sync complete',
    });
  } catch (error: any) {
    console.error('Sync trades error', { error, userId, accountId });
    return errorResponse(500, ErrorCodes.INTERNAL_ERROR, 'Failed to sync trades');
  }
};

async function fetchTradesForDay(
  userId: string, accountId: string | undefined, day: string, timeZone: string | null,
): Promise<any[]> {
  const keyRows = await queryTradeKeysForDay(userId, day, timeZone);
  const full = await loadFullRecords(userId, keyRows);
  return [...full.values()].filter((it: any) =>
    !it.deletedAt && (!accountId || it.accountId === accountId) && dayOf(it.openDate, timeZone) === day);
}

async function queryTradeKeysForDay(
  userId: string, day: string, timeZone: string | null,
): Promise<{ userId: string; tradeId: string }[]> {
  const keys: { userId: string; tradeId: string }[] = [];
  const { start, end } = dayQueryRange(day, timeZone);
  let exclusiveStartKey: Record<string, any> | undefined;
  do {
    const result = await ddb.send(new QueryCommand({
      TableName: TRADES_TABLE,
      IndexName: 'trades-by-date-gsi',
      KeyConditionExpression: 'userId = :u AND #od BETWEEN :start AND :end',
      ExpressionAttributeValues: { ':u': userId, ':start': start, ':end': end },
      ExpressionAttributeNames: { '#od': 'openDate' },
      ExclusiveStartKey: exclusiveStartKey,
    }));
    if (result.Items) {
      for (const item of result.Items) {
        keys.push({ userId: item.userId, tradeId: item.tradeId });
      }
    }
    exclusiveStartKey = result.LastEvaluatedKey;
  } while (exclusiveStartKey);
  return keys;
}
