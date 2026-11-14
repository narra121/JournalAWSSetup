import type { ApiHandler } from '../../shared/types';
import { ddb } from '../../shared/dynamo';
import { QueryCommand } from '@aws-sdk/lib-dynamodb';
import { makeLogger } from '../../shared/logger';
import { envelope, errorResponse, ErrorCodes } from '../../shared/validation';
import { getUserId } from '../../shared/auth';
import { loadFullRecords } from '../../shared/tradeRecords';
import { presentTrade } from '../../shared/presentTrade';
import { dayOf, dayQueryRange, getUserTimeZone, isCalendarDay } from '../../shared/timezone';

const TRADES_TABLE = process.env.TRADES_TABLE!;

export const handler: ApiHandler = async (event) => {
  const userId = getUserId(event);
  const requestId = event.requestContext.requestId;
  const log = makeLogger({ requestId, userId });
  try {
    if (!userId) { 
      log.warn('Unauthorized access list-trades'); 
      return errorResponse(401, ErrorCodes.UNAUTHORIZED, 'Unauthorized');
    }
    const query = event.queryStringParameters || {};
    const accountId = query.accountId;
    const startDate = query.startDate;
    const endDate = query.endDate;
    
    log.info('List trades request', { accountId, startDate, endDate });
    
    // Require accountId, startDate, and endDate
    if (!accountId) {
      log.warn('Missing required parameter: accountId');
      return errorResponse(400, ErrorCodes.VALIDATION_ERROR, 'accountId is required');
    }
    
    if (!startDate || !endDate) {
      log.warn('Missing required date parameters');
      return errorResponse(400, ErrorCodes.VALIDATION_ERROR, 'Both startDate and endDate are required');
    }
    
    // If accountId is 'ALL', skip account filtering
    const shouldFilterByAccount = accountId !== 'ALL';
    
    log.info('Filter settings', { shouldFilterByAccount, accountId });
    
    const parsedLimit = parseInt(query.limit ?? '', 10);
    const limit = Number.isFinite(parsedLimit) ? Math.min(100, Math.max(1, parsedLimit)) : 50;
    const importBatchId = query.importBatchId;
    const cursor = query.cursor || query.nextToken;
    let exclusiveStartKey: Record<string, any> | undefined;
    if (cursor) {
      try {
        exclusiveStartKey = JSON.parse(Buffer.from(cursor, 'base64').toString());
      } catch {
        log.warn('Invalid cursor format');
        return errorResponse(400, ErrorCodes.VALIDATION_ERROR, 'Invalid cursor format');
      }
    }

    // A bare date is a calendar day in the user's time zone (the day statistics and the app use); an ISO instant is used as it is.
    const isDay = (v: string) => v.length === 10;
    if ((isDay(startDate) && !isCalendarDay(startDate)) || (isDay(endDate) && !isCalendarDay(endDate))) {
      return errorResponse(400, ErrorCodes.VALIDATION_ERROR, 'startDate and endDate must be dates (YYYY-MM-DD) or ISO instants');
    }
    const timeZone = isDay(startDate) || isDay(endDate) ? await getUserTimeZone(userId).catch(() => null) : null;
    const rangeStart = isDay(startDate) ? dayQueryRange(startDate, timeZone).start : startDate;
    const inclusiveEnd = isDay(endDate) ? dayQueryRange(endDate, timeZone).end : endDate;
    // The query range can include neighbouring-day rows (see dayQueryRange): a bare-day bound keeps only that local day.
    const inDays = (openDate: string) => (!isDay(startDate) || dayOf(openDate, timeZone) >= startDate) && (!isDay(endDate) || dayOf(openDate, timeZone) <= endDate);
    const matches = (it: any, openDate: string) =>
      !it.deletedAt && (!shouldFilterByAccount || it.accountId === accountId) && (!importBatchId || it.importBatchId === importBatchId) && inDays(openDate);

    // Walk the date index (keys only) page by page, load the full records, and stop as soon as `limit` records match.
    // The cursor is the index key of the last record consumed, so no record is skipped or repeated between pages.
    const items: any[] = [];
    let pageKey = exclusiveStartKey;
    let lastConsumed: Record<string, any> | undefined;
    let hasMore = false;
    const MAX_PAGES = 20;
    for (let page = 0; page < MAX_PAGES; page++) {
      const result = await ddb.send(new QueryCommand({
        TableName: TRADES_TABLE,
        IndexName: 'trades-by-date-gsi',
        KeyConditionExpression: 'userId = :u AND #od BETWEEN :start AND :end',
        ExpressionAttributeValues: { ':u': userId, ':start': rangeStart, ':end': inclusiveEnd },
        ExpressionAttributeNames: { '#od': 'openDate' },
        // Newest first: a page limit (or a client that stops at a ceiling) keeps the most recent trades.
        ScanIndexForward: false,
        Limit: Math.max(limit * 2, 50),
        ExclusiveStartKey: pageKey,
      }));
      const keyRows = result.Items || [];
      const full = await loadFullRecords(userId, keyRows);

      let stoppedEarly = false;
      for (let i = 0; i < keyRows.length; i++) {
        const row = keyRows[i];
        lastConsumed = { userId: row.userId, tradeId: row.tradeId, openDate: row.openDate };
        const record = full.get(row.tradeId);
        if (record && matches(record, row.openDate)) items.push(record);
        if (items.length >= limit) {
          stoppedEarly = i < keyRows.length - 1;
          break;
        }
      }
      if (items.length >= limit) {
        hasMore = stoppedEarly || !!result.LastEvaluatedKey;
        break;
      }
      if (!result.LastEvaluatedKey) break;
      pageKey = result.LastEvaluatedKey;
      if (page === MAX_PAGES - 1) hasMore = true;
    }
    if (hasMore && !lastConsumed) hasMore = false;

    log.info('Query results', {
      itemCount: items.length,
      sampleAccountIds: items.slice(0, 3).map((i: any) => i.accountId),
      hasMore,
    });
    
    const presented = items.map(presentTrade);
    const nextCursor = hasMore ? Buffer.from(JSON.stringify(lastConsumed)).toString('base64') : null;

    log.info('Trades listed', { count: items.length, hasMore });
    return envelope({
      statusCode: 200,
      data: {
        trades: presented,
        pagination: {
          nextCursor,
          hasMore,
          limit,
        },
        // Keep nextToken for backward compatibility
        nextToken: nextCursor ?? undefined,
      },
      message: 'Trades retrieved',
    });
  } catch (e) {
  log.error('list-trades failed', { error: (e as any)?.message });
    return errorResponse(500, ErrorCodes.INTERNAL_ERROR, 'Internal error');
  }
};
