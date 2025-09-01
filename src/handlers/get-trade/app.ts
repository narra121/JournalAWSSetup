import { APIGatewayProxyHandlerV2 } from 'aws-lambda';
import { ddb } from '../../shared/dynamo';
import { GetCommand } from '@aws-sdk/lib-dynamodb';
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { makeLogger } from '../../shared/logger';
import { errorFromException } from '../../shared/validation';
import { normalizePotentialKey } from '../../shared/s3';

const TRADES_TABLE = process.env.TRADES_TABLE!;
const IMAGES_BUCKET = process.env.IMAGES_BUCKET!;
const s3 = new S3Client({});

export const handler: APIGatewayProxyHandlerV2 = async (event) => {
  const userId = (event.requestContext as any)?.authorizer?.jwt?.claims?.sub;
  const requestId = event.requestContext.requestId;
  const log = makeLogger({ requestId, userId });
  try {
    if (!userId) { log.warn('Unauthorized access get-trade'); return resp(401, { message: 'Unauthorized' }); }
    const tradeId = event.pathParameters?.tradeId;
    if (!tradeId) { log.warn('Missing tradeId'); return resp(400, { message: 'Missing tradeId' }); }
    const result = await ddb.send(new GetCommand({ TableName: TRADES_TABLE, Key: { userId, tradeId } }));
    if (!result.Item) { log.info('Trade not found', { tradeId }); return resp(404, { message: 'Not found' }); }
    const item: any = result.Item;
    // Guarantee netPnl field
    if (item.netPnl == null) {
      const pnl = typeof item.pnl === 'number' ? item.pnl : null;
      const commission = typeof item.commission === 'number' ? item.commission : 0;
      const fees = typeof item.fees === 'number' ? item.fees : 0;
      if (pnl != null) item.netPnl = pnl - (commission + fees);
    }
    if (Array.isArray(item.images)) {
      item.images = await Promise.all(item.images.map(async (im: any) => {
        const keyCandidate = im.key || normalizePotentialKey(im.url, IMAGES_BUCKET);
        if (keyCandidate) {
          const url = await getSignedUrl(s3, new GetObjectCommand({ Bucket: IMAGES_BUCKET, Key: keyCandidate }), { expiresIn: 900 });
          return { ...im, key: keyCandidate, url };
        }
        return im;
      }));
    }
    log.info('Trade fetched', { tradeId });
    return resp(200, item);
  } catch (e: any) {
    log.error('get-trade failed', { error: e.message, stack: e.stack });
    return errorFromException(e, true);
  }
};

function resp(statusCode: number, body: any) { return { statusCode, body: JSON.stringify(body) }; }
