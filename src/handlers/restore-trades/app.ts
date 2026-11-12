import type { ApiHandler } from '../../shared/types';
import { envelope, errorResponse, ErrorCodes } from '../../shared/validation';
import { getUserId } from '../../shared/auth';
import { makeLogger } from '../../shared/logger';
import { restoreTrade } from '../../shared/softDelete';

const MAX_IDS = 200;

/** POST /v1/trades/restore { tradeIds }: brings soft-deleted trades back (within the 30-day window). */
export const handler: ApiHandler = async (event) => {
  const log = makeLogger({ requestId: event.requestContext.requestId, userId: getUserId(event) ?? undefined });
  try {
    const userId = getUserId(event);
    if (!userId) return errorResponse(401, ErrorCodes.UNAUTHORIZED, 'Unauthorized');

    let payload: any;
    try { payload = JSON.parse(event.body || 'null'); } catch { return errorResponse(400, ErrorCodes.VALIDATION_ERROR, 'Invalid JSON'); }
    const requested: unknown[] = Array.isArray(payload?.tradeIds) ? payload.tradeIds : [];
    if (!requested.length || requested.some((id) => typeof id !== 'string' || !id)) {
      return errorResponse(400, ErrorCodes.VALIDATION_ERROR, 'tradeIds must be a non-empty list of ids');
    }
    const ids = [...new Set(requested as string[])];
    if (ids.length > MAX_IDS) return errorResponse(400, ErrorCodes.VALIDATION_ERROR, `Max ${MAX_IDS} tradeIds per request`);

    const restored: string[] = [];
    const notFound: string[] = [];
    const errors: { tradeId: string; message: string }[] = [];
    for (let i = 0; i < ids.length; i += 10) {
      await Promise.all(
        ids.slice(i, i + 10).map(async (tradeId) => {
          try {
            if (await restoreTrade(userId, tradeId)) restored.push(tradeId);
            else notFound.push(tradeId);
          } catch (e: any) {
            errors.push({ tradeId, message: e.message || 'error' });
          }
        }),
      );
    }
    return envelope({ statusCode: 200, data: { restored, notFound, errors }, message: 'Trades restored' });
  } catch (e: any) {
    log.error('restore-trades failed', { error: e.message, stack: e.stack });
    return errorResponse(500, ErrorCodes.INTERNAL_ERROR, 'Internal error');
  }
};
