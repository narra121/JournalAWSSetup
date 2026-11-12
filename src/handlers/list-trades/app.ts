import type { ApiHandler } from '../../shared/types';
import { ddb } from '../../shared/dynamo';
import { QueryCommand, BatchGetCommand } from '@aws-sdk/lib-dynamodb';
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import { makeLogger } from '../../shared/logger';
import { normalizePotentialKey } from '../../shared/s3';
import { envelope, errorResponse, ErrorCodes } from '../../shared/validation';
import { getUserId } from '../../shared/auth';

const TRADES_TABLE = process.env.TRADES_TABLE!;
const IMAGES_BUCKET = process.env.IMAGES_BUCKET!;
const s3 = new S3Client({});

/** Loads full records for index rows (BatchGet in chunks of 100, retrying unprocessed keys); returns them by tradeId. */
async function loadFullRecords(userId: string, keyRows: Record<string, any>[]): Promise<Map<string, any>> {
  const found = new Map<string, any>();
  for (let i = 0; i < keyRows.length; i += 100) {
    let keys: Record<string, any>[] = keyRows.slice(i, i + 100).map((r) => ({ userId, tradeId: r.tradeId }));
    for (let attempt = 0; keys.length > 0 && attempt < 4; attempt++) {
      if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, 50 * Math.pow(2, attempt)));
      const res = await ddb.send(new BatchGetCommand({ RequestItems: { [TRADES_TABLE]: { Keys: keys } } }));
      for (const it of res.Responses?.[TRADES_TABLE] ?? []) found.set(it.tradeId, it);
      keys = (res.UnprocessedKeys?.[TRADES_TABLE]?.Keys as Record<string, any>[] | undefined) ?? [];
    }
    if (keys.length > 0) throw new Error('Could not load all trade records');
  }
  return found;
}

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

    const inclusiveEnd = endDate.length === 10 ? endDate + 'T23:59:59.999Z' : endDate;
    const matches = (it: any) =>
      !it.deletedAt && (!shouldFilterByAccount || it.accountId === accountId) && (!importBatchId || it.importBatchId === importBatchId);

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
        ExpressionAttributeValues: { ':u': userId, ':start': startDate, ':end': inclusiveEnd },
        ExpressionAttributeNames: { '#od': 'openDate' },
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
        if (record && matches(record)) items.push(record);
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
    
    // Presign image keys (short-lived) if present
  if (items.length) {
      await Promise.all(items.map(async (it: any) => {
    if (it.achievedRiskRewardRatio === undefined) it.achievedRiskRewardRatio = null;
        // Remove accountIds field (legacy) - each trade has only one accountId
        if (it.accountIds) delete it.accountIds;
        if (Array.isArray(it.images)) {
          it.images = it.images.map((im: any) => {
            const keyCandidate = im.key || normalizePotentialKey(im.url, IMAGES_BUCKET);
            if (keyCandidate) {
              // Return image ID instead of signed URL
              return { ...im, id: keyCandidate, key: keyCandidate };
            }
            return { ...im, id: im.id || im.key || '' };
          });
        }
      }));
    }
    const nextCursor = hasMore ? Buffer.from(JSON.stringify(lastConsumed)).toString('base64') : null;

    log.info('Trades listed', { count: items.length, hasMore });
    return envelope({
      statusCode: 200,
      data: {
        trades: items,
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
