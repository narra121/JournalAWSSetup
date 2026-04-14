import { APIGatewayProxyHandlerV2 } from 'aws-lambda';
import { ddb } from '../../shared/dynamo';
import { BatchWriteCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { removeImagesForTrade } from '../../shared/images';
import { envelope, errorResponse, ErrorCodes } from '../../shared/validation';
import { getUserId } from '../../shared/auth';
import { checkSubscription } from '../../shared/subscription';
import { makeLogger } from '../../shared/logger';

const TRADES_TABLE = process.env.TRADES_TABLE!;

export const handler: APIGatewayProxyHandlerV2 = async (event) => {
  const log = makeLogger({ requestId: event.requestContext.requestId, userId: getUserId(event) ?? undefined });
  try {
    const userId = getUserId(event);
    if (!userId) return errorResponse(401, ErrorCodes.UNAUTHORIZED, 'Unauthorized');

    const subError = await checkSubscription(userId);
    if (subError) return subError;

    if (!event.body) return errorResponse(400, ErrorCodes.VALIDATION_ERROR, 'Missing body');
    let payload: any;
    try { payload = JSON.parse(event.body); } catch { return errorResponse(400, ErrorCodes.VALIDATION_ERROR, 'Invalid JSON'); }
    const ids: string[] = Array.isArray(payload.tradeIds) ? payload.tradeIds : [];
    if (!ids.length) return errorResponse(400, ErrorCodes.VALIDATION_ERROR, 'tradeIds array required');
    if (ids.length > 50) return errorResponse(400, ErrorCodes.VALIDATION_ERROR, 'Max 50 tradeIds per request');

    const toDelete = ids.map(tid => ({ DeleteRequest: { Key: { userId, tradeId: tid } } }));
    const CHUNK = 25;
    const errors: any[] = [];
    for (let i = 0; i < toDelete.length; i += CHUNK) {
      let slice = toDelete.slice(i, i + CHUNK);
      let unprocessed = slice;
      let attempts = 0;
      while (unprocessed.length && attempts < 3) {
        const respBW = await ddb.send(new BatchWriteCommand({
          RequestItems: { [TRADES_TABLE]: unprocessed }
        }));
        const up = respBW.UnprocessedItems?.[TRADES_TABLE];
        if (up && up.length) {
          unprocessed = up as any[];
          attempts++;
          await new Promise(r => setTimeout(r, 50 * attempts));
        } else {
          unprocessed = [];
        }
      }
      if (unprocessed.length) {
        for (const r of unprocessed) {
          errors.push({ tradeId: (r as any).DeleteRequest?.Key?.tradeId, message: 'Unprocessed after retries' });
        }
      }
    }

    // Parallel image deletion in batches of 10
    const IMG_BATCH = 10;
    for (let i = 0; i < ids.length; i += IMG_BATCH) {
      await Promise.allSettled(
        ids.slice(i, i + IMG_BATCH).map(tid => removeImagesForTrade(userId, tid))
      );
    }

    return envelope({ statusCode: 200, data: { deletedRequested: ids.length, errors }, message: 'Trades deleted' });
  } catch (e: any) {
    log.error('bulk-delete-trades failed', { error: e.message, stack: e.stack });
    return errorResponse(500, ErrorCodes.INTERNAL_ERROR, 'Internal error');
  }
};
