import { APIGatewayProxyHandlerV2 } from 'aws-lambda';
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

export const handler: APIGatewayProxyHandlerV2 = async (event) => {
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
    
    const limit = query.limit ? Math.min(100, Math.max(1, parseInt(query.limit))) : 50;
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

    // Query trades — GSI for date range, main table for no-date queries
    let command;
    if (startDate && endDate) {
      // GSI query: userId + openDate range (KEYS_ONLY — no FilterExpression here)
      const inclusiveEnd = endDate.length === 10 ? endDate + 'T23:59:59.999Z' : endDate;
      command = new QueryCommand({
        TableName: TRADES_TABLE,
        IndexName: 'trades-by-date-gsi',
        KeyConditionExpression: 'userId = :u AND #od BETWEEN :start AND :end',
        ExpressionAttributeValues: { ':u': userId, ':start': startDate, ':end': inclusiveEnd },
        ExpressionAttributeNames: { '#od': 'openDate' },
        ExclusiveStartKey: exclusiveStartKey,
      });
    } else {
      // Main table query: userId only, accountId filter works here (full record available)
      const exprValues: Record<string, any> = { ':u': userId };
      const exprNames: Record<string, string> = {};
      let filterExpression: string | undefined;
      if (shouldFilterByAccount) {
        filterExpression = '#aid = :aid';
        exprValues[':aid'] = accountId;
        exprNames['#aid'] = 'accountId';
      }
      command = new QueryCommand({
        TableName: TRADES_TABLE,
        KeyConditionExpression: 'userId = :u',
        FilterExpression: filterExpression,
        ExpressionAttributeValues: exprValues,
        ExpressionAttributeNames: Object.keys(exprNames).length > 0 ? exprNames : undefined,
        Limit: limit,
        ExclusiveStartKey: exclusiveStartKey,
      });
    }

    const result = await ddb.send(command);
    let items = result.Items || [];

    // GSI returns KEYS_ONLY — BatchGet full records from main table
    if (startDate && endDate && items.length > 0) {
      const keys = items.map((it: any) => ({ userId: it.userId, tradeId: it.tradeId }));
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
      const fullMap = new Map(fullItems.map((it: any) => [it.tradeId, it]));
      items = items.map((it: any) => fullMap.get(it.tradeId) || it);
    }

    // Account filter applied AFTER full data is fetched (GSI doesn't have accountId)
    if (shouldFilterByAccount) {
      items = items.filter((it: any) => it.accountId === accountId);
    }

    log.info('Query results', {
      itemCount: items.length,
      sampleAccountIds: items.slice(0, 3).map((i: any) => i.accountId),
      hasMore: !!result.LastEvaluatedKey,
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
    const nextCursor = result.LastEvaluatedKey
      ? Buffer.from(JSON.stringify(result.LastEvaluatedKey)).toString('base64')
      : null;
    const hasMore = !!result.LastEvaluatedKey;

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
