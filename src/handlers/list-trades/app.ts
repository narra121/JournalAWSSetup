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

    let command;
    if (startDate && endDate) {
      // Ensure endDate is inclusive of the full day (openDate stored as ISO datetime)
      const inclusiveEnd = endDate.length === 10 ? endDate + 'T23:59:59.999Z' : endDate;
      const exprValues: Record<string, any> = { ':u': userId, ':start': startDate, ':end': inclusiveEnd };
      const exprNames: Record<string, string> = { '#od': 'openDate' };
      
      // Add accountId filter at DB level using FilterExpression (skip if 'ALL')
      let filterExpression = undefined;
      if (shouldFilterByAccount) {
        // Filter by exact accountId only (don't include -1 "all accounts" trades)
        filterExpression = '#aid = :aid';
        exprValues[':aid'] = accountId;
        exprNames['#aid'] = 'accountId';
        log.info('Adding accountId filter', { filterExpression, accountIdValue: accountId });
      }
      
      command = new QueryCommand({
        TableName: TRADES_TABLE,
        IndexName: 'trades-by-date-gsi',
        KeyConditionExpression: 'userId = :u AND #od BETWEEN :start AND :end',
        FilterExpression: filterExpression,
        ExpressionAttributeValues: exprValues,
        ExpressionAttributeNames: exprNames,
        Limit: limit,
        ExclusiveStartKey: exclusiveStartKey
      });
    } else {
      const exprValues: Record<string, any> = { ':u': userId };
      
      // Add accountId filter at DB level using FilterExpression (skip if 'ALL')
      let filterExpression = undefined;
      const exprNames: Record<string, string> = {};
      if (shouldFilterByAccount) {
        // Filter by exact accountId only (don't include -1 "all accounts" trades)
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
        ExclusiveStartKey: exclusiveStartKey
      });
    }
  const result = await ddb.send(command);
    let items = result.Items || [];

    log.info('Query results', {
      itemCount: items.length,
      sampleAccountIds: items.slice(0, 3).map((i: any) => i.accountId),
      hasMore: !!result.LastEvaluatedKey
    });

    // GSI returns KEYS_ONLY — fetch full records from main table
    if (startDate && endDate && items.length > 0) {
      const keys = items.map((it: any) => ({ userId: it.userId, tradeId: it.tradeId }));
      const chunks: Record<string, any>[][] = [];
      for (let i = 0; i < keys.length; i += 100) {
        chunks.push(keys.slice(i, i + 100));
      }
      const fullItems: any[] = [];
      for (const chunk of chunks) {
        const batchResult = await ddb.send(new BatchGetCommand({
          RequestItems: { [TRADES_TABLE]: { Keys: chunk } },
        }));
        if (batchResult.Responses?.[TRADES_TABLE]) {
          fullItems.push(...batchResult.Responses[TRADES_TABLE]);
        }
      }
      // Replace GSI items with full items, preserving order by openDate desc
      const fullMap = new Map(fullItems.map((it: any) => [it.tradeId, it]));
      items = items.map((it: any) => fullMap.get(it.tradeId) || it);
    }
    
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
