import type { ApiHandler } from '../../shared/types';
import { GetCommand } from '@aws-sdk/lib-dynamodb';
import { ddb } from '../../shared/dynamo';
import { getUserId } from '../../shared/auth';
import { makeLogger } from '../../shared/logger';
import { envelope, errorResponse, ErrorCodes } from '../../shared/validation';
import { presentTrade } from '../../shared/presentTrade';

const TRADES_TABLE = process.env.TRADES_TABLE!;

export const handler: ApiHandler = async (event) => {
  const log = makeLogger({ requestId: event.requestContext.requestId, userId: getUserId(event) ?? undefined });
  try {
    const userId = getUserId(event);
    if (!userId) return errorResponse(401, ErrorCodes.UNAUTHORIZED, 'Unauthorized');

    const tradeId = event.pathParameters?.tradeId;
    if (!tradeId) return errorResponse(400, ErrorCodes.VALIDATION_ERROR, 'Missing tradeId');

    const { Item } = await ddb.send(new GetCommand({ TableName: TRADES_TABLE, Key: { userId, tradeId } }));
    if (!Item || Item.deletedAt) return errorResponse(404, ErrorCodes.NOT_FOUND, 'Not found');

    return envelope({ statusCode: 200, data: { trade: presentTrade(Item) } });
  } catch (e: any) {
    log.error('get-trade failed', { error: e.message, stack: e.stack });
    return errorResponse(500, ErrorCodes.INTERNAL_ERROR, 'Internal error');
  }
};
