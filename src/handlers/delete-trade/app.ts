import type { ApiHandler } from '../../shared/types';
import { errorResponse, envelope, ErrorCodes } from '../../shared/validation';
import { getUserId } from '../../shared/auth';
import { checkSubscription } from '../../shared/subscription';
import { makeLogger } from '../../shared/logger';
import { softDeleteTrade } from '../../shared/softDelete';

/** Soft delete: the trade is hidden everywhere and can be restored for 30 days (POST /v1/trades/restore). */
export const handler: ApiHandler = async (event) => {
  const log = makeLogger({ requestId: event.requestContext.requestId, userId: getUserId(event) ?? undefined });
  try {
    const userId = getUserId(event);
    if (!userId) return errorResponse(401, ErrorCodes.UNAUTHORIZED, 'Unauthorized');

    const subError = await checkSubscription(userId);
    if (subError) return subError;

    const tradeId = event.pathParameters?.tradeId;
    if (!tradeId) return errorResponse(400, ErrorCodes.VALIDATION_ERROR, 'Missing tradeId');

    const trade = await softDeleteTrade(userId, tradeId);
    if (!trade) return errorResponse(404, ErrorCodes.NOT_FOUND, 'Not found');

    return envelope({ statusCode: 200, data: { trade: { ...trade, deletedAt: new Date().toISOString() } }, message: 'Deleted' });
  } catch (e: any) {
    log.error('delete-trade failed', { error: e.message, stack: e.stack });
    return errorResponse(500, ErrorCodes.INTERNAL_ERROR, 'Internal error');
  }
};
