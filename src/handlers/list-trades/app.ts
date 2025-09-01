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
    if (!userId) { log.warn('Unauthorized access list-trades'); return resp(401, { message: 'Unauthorized' }); }
    const query = event.queryStringParameters || {};
    const startDate = query.startDate;
    const endDate = query.endDate;
    const symbol = query.symbol;
    const status = query.status;
    const tag = query.tag; // simple filter post-query
    const limit = query.limit ? Math.min(100, Math.max(1, parseInt(query.limit))) : 50;
    const nextToken = query.nextToken ? Buffer.from(query.nextToken, 'base64').toString('utf-8') : undefined;
    let exclusiveStartKey = nextToken ? JSON.parse(nextToken) : undefined;

    let command;
    if (symbol) {
      // Query symbol GSI: user-symbol-date-gsi with begins_with on composite (symbol#date)
      const base = `${symbol}#`;
      if (startDate || endDate) {
        const startKey = `${symbol}#${startDate || '0000-00-00'}`;
        const endKey = `${symbol}#${endDate || '9999-12-31'}`;
        command = new QueryCommand({
          TableName: TRADES_TABLE,
          IndexName: 'user-symbol-date-gsi',
          KeyConditionExpression: 'userId = :u AND symbolOpenDate BETWEEN :start AND :end',
          ExpressionAttributeValues: { ':u': userId, ':start': startKey, ':end': endKey },
          Limit: limit,
          ExclusiveStartKey: exclusiveStartKey
        });
      } else {
        command = new QueryCommand({
          TableName: TRADES_TABLE,
          IndexName: 'user-symbol-date-gsi',
          KeyConditionExpression: 'userId = :u AND begins_with(symbolOpenDate, :p)',
          ExpressionAttributeValues: { ':u': userId, ':p': base },
          Limit: limit,
          ExclusiveStartKey: exclusiveStartKey
        });
      }
    } else if (status) {
      if (startDate || endDate) {
        const startKey = `${status}#${startDate || '0000-00-00'}`;
        const endKey = `${status}#${endDate || '9999-12-31'}`;
        command = new QueryCommand({
          TableName: TRADES_TABLE,
          IndexName: 'user-status-date-gsi',
          KeyConditionExpression: 'userId = :u AND statusOpenDate BETWEEN :start AND :end',
          ExpressionAttributeValues: { ':u': userId, ':start': startKey, ':end': endKey },
          Limit: limit,
          ExclusiveStartKey: exclusiveStartKey
        });
      } else {
        command = new QueryCommand({
          TableName: TRADES_TABLE,
          IndexName: 'user-status-date-gsi',
          KeyConditionExpression: 'userId = :u AND begins_with(statusOpenDate, :p)',
          ExpressionAttributeValues: { ':u': userId, ':p': `${status}#` },
          Limit: limit,
          ExclusiveStartKey: exclusiveStartKey
        });
      }
    } else if (startDate || endDate) {
      const conditions: string[] = [];
      const exprValues: Record<string, any> = { ':u': userId };
      if (startDate) { conditions.push('#od >= :start'); exprValues[':start'] = startDate; }
      if (endDate) { conditions.push('#od <= :end'); exprValues[':end'] = endDate; }
      command = new QueryCommand({
        TableName: TRADES_TABLE,
        IndexName: 'trades-by-date-gsi',
        KeyConditionExpression: 'userId = :u' + (conditions.length ? ' AND ' + conditions.join(' AND ') : ''),
        ExpressionAttributeValues: exprValues,
        ExpressionAttributeNames: { '#od': 'openDate' },
        Limit: limit,
        ExclusiveStartKey: exclusiveStartKey
      });
    } else {
      command = new QueryCommand({
        TableName: TRADES_TABLE,
        KeyConditionExpression: 'userId = :u',
        ExpressionAttributeValues: { ':u': userId },
        Limit: limit,
        ExclusiveStartKey: exclusiveStartKey
      });
    }
  const result = await ddb.send(command);
    let items = result.Items || [];
    // Guarantee netPnl on each item
    for (const it of items) {
      if (it && it.netPnl == null) {
        const pnl = typeof it.pnl === 'number' ? it.pnl : null;
        const commission = typeof it.commission === 'number' ? it.commission : 0;
        const fees = typeof it.fees === 'number' ? it.fees : 0;
        if (pnl != null) it.netPnl = pnl - (commission + fees);
      }
    }
    if (tag) {
      items = items.filter(i => Array.isArray(i.tags) && i.tags.includes(tag));
    }
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
  return resp(200, { items, nextToken: newNextToken });
  } catch (e) {
  log.error('list-trades failed', { error: (e as any)?.message });
    return resp(500, { message: 'Internal error' });
  }
};

function resp(statusCode: number, body: any) { return { statusCode, body: JSON.stringify(body) }; }
