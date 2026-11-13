import type { ApiHandler } from '../../shared/types';
import { envelope, errorResponse, ErrorCodes } from '../../shared/validation';
import { getUserId } from '../../shared/auth';
import { makeLogger } from '../../shared/logger';
import { softDeleteTrade } from '../../shared/softDelete';

const MAX_IDS = 200;

/** Soft-deletes up to 200 trades (restorable for 30 days). Unknown or already-deleted ids are reported, not fatal. */
export const handler: ApiHandler = async (event) => {
  const log = makeLogger({ requestId: event.requestContext.requestId, userId: getUserId(event) ?? undefined });
  try {
    const userId = getUserId(event);
    if (!userId) return errorResponse(401, ErrorCodes.UNAUTHORIZED, 'Unauthorized');

    if (!event.body) return errorResponse(400, ErrorCodes.VALIDATION_ERROR, 'Missing body');
    let payload: any;
    try { payload = JSON.parse(event.body); } catch { return errorResponse(400, ErrorCodes.VALIDATION_ERROR, 'Invalid JSON'); }
    const requested: unknown[] = Array.isArray(payload?.tradeIds) ? payload.tradeIds : [];
    if (!requested.length) return errorResponse(400, ErrorCodes.VALIDATION_ERROR, 'tradeIds array required');
    if (requested.some((id) => typeof id !== 'string' || !id)) return errorResponse(400, ErrorCodes.VALIDATION_ERROR, 'tradeIds must be strings');
    const ids = [...new Set(requested as string[])];
    if (ids.length > MAX_IDS) return errorResponse(400, ErrorCodes.VALIDATION_ERROR, `Max ${MAX_IDS} tradeIds per request`);

    const deleted: string[] = [];
    const notFound: string[] = [];
    const errors: { tradeId: string; message: string }[] = [];
    for (let i = 0; i < ids.length; i += 10) {
      await Promise.all(
        ids.slice(i, i + 10).map(async (tradeId) => {
          try {
            if (await softDeleteTrade(userId, tradeId)) deleted.push(tradeId);
            else notFound.push(tradeId);
          } catch (e: any) {
            errors.push({ tradeId, message: e.message || 'error' });
          }
        }),
      );
    }

    return envelope({
      statusCode: 200,
      data: { deletedRequested: ids.length, deleted, notFound, errors },
      message: 'Trades deleted',
    });
  } catch (e: any) {
    log.error('bulk-delete-trades failed', { error: e.message, stack: e.stack });
    return errorResponse(500, ErrorCodes.INTERNAL_ERROR, 'Internal error');
  }
};
