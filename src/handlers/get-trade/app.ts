import { APIGatewayProxyHandlerV2 } from 'aws-lambda';
import { ddb } from '../../shared/dynamo';
import { GetCommand } from '@aws-sdk/lib-dynamodb';
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import { makeLogger } from '../../shared/logger';
import { errorFromException, envelope, errorResponse, ErrorCodes } from '../../shared/validation';
import { normalizePotentialKey } from '../../shared/s3';

const TRADES_TABLE = process.env.TRADES_TABLE!;
const IMAGES_BUCKET = process.env.IMAGES_BUCKET!;
const s3 = new S3Client({});

export const handler: APIGatewayProxyHandlerV2 = async (event) => {
  const userId = (event.requestContext as any)?.authorizer?.jwt?.claims?.sub;
  const requestId = event.requestContext.requestId;
  const log = makeLogger({ requestId, userId });
  try {
    if (!userId) { log.warn('Unauthorized access get-trade'); return errorResponse(401, ErrorCodes.UNAUTHORIZED, 'Unauthorized'); }
    const tradeId = event.pathParameters?.tradeId;
    if (!tradeId) { log.warn('Missing tradeId'); return errorResponse(400, ErrorCodes.VALIDATION_ERROR, 'Missing tradeId'); }
    const result = await ddb.send(new GetCommand({ TableName: TRADES_TABLE, Key: { userId, tradeId } }));
    if (!result.Item) { log.info('Trade not found', { tradeId }); return errorResponse(404, ErrorCodes.NOT_FOUND, 'Not found'); }
    const item: any = result.Item;
    // Guarantee netPnl field
    if (item.netPnl == null) {
      const pnl = typeof item.pnl === 'number' ? item.pnl : null;
      const commission = typeof item.commission === 'number' ? item.commission : 0;
      const fees = typeof item.fees === 'number' ? item.fees : 0;
      if (pnl != null) item.netPnl = pnl - (commission + fees);
    }
  if (item.achievedRiskRewardRatio === undefined) item.achievedRiskRewardRatio = null;
  // Remove accountIds field (legacy) - each trade has only one accountId
  if (item.accountIds) delete item.accountIds;
  if (Array.isArray(item.images)) {
      item.images = item.images.map((im: any) => {
        const keyCandidate = im.key || normalizePotentialKey(im.url, IMAGES_BUCKET);
        if (keyCandidate) {
          // Return image ID instead of signed URL
          return { ...im, id: keyCandidate, key: keyCandidate };
        }
        return { ...im, id: im.id || im.key || '' };
      });
    }
    log.info('Trade fetched', { tradeId });
    return envelope({ statusCode: 200, data: { trade: item }, message: 'Trade retrieved' });
  } catch (e: any) {
    log.error('get-trade failed', { error: e.message, stack: e.stack });
    return errorFromException(e, true);
  }
};
