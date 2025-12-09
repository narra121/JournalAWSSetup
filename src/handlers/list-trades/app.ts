import { APIGatewayProxyHandlerV2 } from 'aws-lambda';
import { ddb } from '../../shared/dynamo';
import { QueryCommand } from '@aws-sdk/lib-dynamodb';
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { makeLogger } from '../../shared/logger';
import { normalizePotentialKey } from '../../shared/s3';

const TRADES_TABLE = process.env.TRADES_TABLE!;
const IMAGES_BUCKET = process.env.IMAGES_BUCKET!;
const s3 = new S3Client({});

export const handler: APIGatewayProxyHandlerV2 = async (event) => {
  const userId = (event.requestContext as any)?.authorizer?.jwt?.claims?.sub;
  const requestId = event.requestContext.requestId;
  const log = makeLogger({ requestId, userId });
  try {
    if (!userId) { 
      log.warn('Unauthorized access list-trades'); 
      return {
        statusCode: 401,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ data: null, error: { code: 'UNAUTHORIZED', message: 'Unauthorized' }, meta: null })
      };
    }
    const query = event.queryStringParameters || {};
    const accountId = query.accountId;
    const startDate = query.startDate;
    const endDate = query.endDate;
    
    // Require accountId, startDate, and endDate
    if (!accountId) {
      log.warn('Missing required parameter: accountId');
      return {
        statusCode: 400,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 
          data: null, 
          error: { 
            code: 'MISSING_ACCOUNT_ID', 
            message: 'accountId is required' 
          }, 
          meta: null 
        })
      };
    }
    
    if (!startDate || !endDate) {
      log.warn('Missing required date parameters');
      return {
        statusCode: 400,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 
          data: null, 
          error: { 
            code: 'MISSING_DATE_RANGE', 
            message: 'Both startDate and endDate are required' 
          }, 
          meta: null 
        })
      };
    }
    
    // If accountId is 'ALL', skip account filtering
    const shouldFilterByAccount = accountId !== 'ALL';
    
    const limit = query.limit ? Math.min(100, Math.max(1, parseInt(query.limit))) : 50;
    const nextToken = query.nextToken ? Buffer.from(query.nextToken, 'base64').toString('utf-8') : undefined;
    let exclusiveStartKey = nextToken ? JSON.parse(nextToken) : undefined;

    let command;
    if (startDate && endDate) {
      const exprValues: Record<string, any> = { ':u': userId, ':start': startDate, ':end': endDate };
      const exprNames: Record<string, string> = { '#od': 'openDate' };
      
      // Add accountId filter at DB level using FilterExpression (skip if 'ALL')
      let filterExpression = undefined;
      if (shouldFilterByAccount) {
        filterExpression = '#aid = :aid OR #aid = :all';
        exprValues[':aid'] = accountId;
        exprValues[':all'] = '-1';
        exprNames['#aid'] = 'accountId';
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
        filterExpression = '#aid = :aid OR #aid = :all';
        exprValues[':aid'] = accountId;
        exprValues[':all'] = '-1';
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
    
    // Presign image keys (short-lived) if present
  if (items.length) {
      await Promise.all(items.map(async (it: any) => {
    if (it.achievedRiskRewardRatio === undefined) it.achievedRiskRewardRatio = null;
        if (Array.isArray(it.images)) {
          it.images = await Promise.all(it.images.map(async (im: any) => {
            const keyCandidate = im.key || normalizePotentialKey(im.url, IMAGES_BUCKET);
            if (keyCandidate) {
              const url = await getSignedUrl(s3, new GetObjectCommand({ Bucket: IMAGES_BUCKET, Key: keyCandidate }), { expiresIn: 900 });
              return { ...im, key: keyCandidate, url };
            }
            return im;
          }));
        }
      }));
    }
    const newNextToken = result.LastEvaluatedKey ? Buffer.from(JSON.stringify(result.LastEvaluatedKey)).toString('base64') : undefined;
  log.info('Trades listed', { count: items.length, hasMore: !!newNextToken });
  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ data: { trades: items, nextToken: newNextToken }, error: null, meta: null })
  };
  } catch (e) {
  log.error('list-trades failed', { error: (e as any)?.message });
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ data: null, error: { code: 'INTERNAL_ERROR', message: 'Internal error' }, meta: null })
    };
  }
};
