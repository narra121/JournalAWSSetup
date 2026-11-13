import type { ApiHandler } from '../../shared/types';
import { ddb } from '../../shared/dynamo';
import { QueryCommand } from '@aws-sdk/lib-dynamodb';
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import { makeLogger } from '../../shared/logger';
import { normalizePotentialKey } from '../../shared/s3';
import { loadFullRecords } from '../../shared/tradeRecords';
import { envelope, errorResponse, ErrorCodes } from '../../shared/validation';

const TRADES_TABLE = process.env.TRADES_TABLE!;
const IMAGES_BUCKET = process.env.IMAGES_BUCKET!;
const s3 = new S3Client({});

export const handler: ApiHandler = async (event) => {
  const userId = event.pathParameters?.userId;
  const requestId = event.requestContext.requestId;
  const log = makeLogger({ requestId, userId });
  try {
    if (!userId) {
      log.warn('Missing userId path parameter');
      return errorResponse(400, ErrorCodes.VALIDATION_ERROR, 'userId path parameter is required');
    }
    const query = event.queryStringParameters || {};
    const accountId = query.accountId;
    const startDate = query.startDate;
    const endDate = query.endDate;

    log.info('Admin list trades request', { userId, accountId, startDate, endDate });

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
    const limit = Number.isNaN(parsedLimit) ? 50 : Math.min(100, Math.max(1, parsedLimit));
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

    // GSI query: userId + openDate range (KEYS_ONLY), then the full records from the main table. The GSI has no
    // accountId, so for one account several index pages may be read until the page is full.
    const inclusiveEnd = endDate.length === 10 ? endDate + 'T23:59:59.999Z' : endDate;
    const MAX_FILL_PAGES = 6;
    let items: any[] = [];
    let lastEvaluatedKey: Record<string, any> | undefined;
    let startKey = exclusiveStartKey;
    for (let page = 0; page < MAX_FILL_PAGES; page++) {
      const result = await ddb.send(
        new QueryCommand({
          TableName: TRADES_TABLE,
          IndexName: 'trades-by-date-gsi',
          KeyConditionExpression: 'userId = :u AND #od BETWEEN :start AND :end',
          ExpressionAttributeValues: { ':u': userId, ':start': startDate, ':end': inclusiveEnd },
          ExpressionAttributeNames: { '#od': 'openDate' },
          Limit: shouldFilterByAccount ? limit * 3 : limit,
          ExclusiveStartKey: startKey,
        }),
      );
      const keyRows = result.Items || [];
      // Retries unprocessed keys and throws when some stay unprocessed, so a throttled read never drops trades silently.
      const full = await loadFullRecords(userId, keyRows);
      for (const row of keyRows) {
        const trade = full.get(row.tradeId);
        if (!trade || trade.deletedAt) continue;
        if (shouldFilterByAccount && trade.accountId !== accountId) continue;
        items.push(trade);
      }
      lastEvaluatedKey = result.LastEvaluatedKey;
      startKey = lastEvaluatedKey;
      if (items.length >= limit || !lastEvaluatedKey) break;
    }

    // The cursor must continue right after the last trade returned, not after everything that was read.
    let nextKey = lastEvaluatedKey;
    if (items.length > limit) {
      items = items.slice(0, limit);
      const last = items[items.length - 1];
      nextKey = { userId: last.userId, openDate: last.openDate, tradeId: last.tradeId };
    }

    log.info('Query results', {
      itemCount: items.length,
      sampleAccountIds: items.slice(0, 3).map((i: any) => i.accountId),
      hasMore: !!nextKey,
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
    const nextCursor = nextKey ? Buffer.from(JSON.stringify(nextKey)).toString('base64') : null;
    const hasMore = !!nextKey;

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
  log.error('admin-list-user-trades failed', { error: (e as any)?.message });
    return errorResponse(500, ErrorCodes.INTERNAL_ERROR, 'Internal error');
  }
};
