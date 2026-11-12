import type { ApiHandler } from '../../shared/types';
import { purgeUser } from '../../shared/account-data';
import { envelope, errorResponse, ErrorCodes, errorFromException } from '../../shared/validation';
import { makeLogger } from '../../shared/logger';

export const handler: ApiHandler = async (event) => {
  const log = makeLogger({ requestId: event.requestContext?.requestId });

  try {
    const userId = event.pathParameters?.userId;
    if (!userId) {
      return errorResponse(400, ErrorCodes.VALIDATION_ERROR, 'userId path parameter is required');
    }

    // Parse and validate confirmation
    let body: any;
    try {
      body = JSON.parse(event.body || '{}');
    } catch {
      return errorResponse(400, ErrorCodes.VALIDATION_ERROR, 'Invalid JSON body');
    }

    if (body.confirmText !== 'delete') {
      return errorResponse(400, ErrorCodes.VALIDATION_ERROR, 'confirmText must be "delete"');
    }

    log.info('Admin deleting user', { targetUserId: userId });

    const purged = await purgeUser(userId, log);
    const { trades, accounts, goals, rules, stats } = purged.deleted;

    log.info('Admin deleted user successfully', { targetUserId: userId, ...purged.deleted, images: purged.images });

    return envelope({
      statusCode: 200,
      data: {
        deletedTrades: trades,
        deletedAccounts: accounts,
        deletedGoals: goals,
        deletedRules: rules,
        deletedStats: stats,
        deletedImages: purged.images,
        stripeSubscriptionCancelled: purged.stripeSubscriptionCancelled,
      },
      message: 'User deleted successfully',
    });
  } catch (err: any) {
    log.error('Admin delete user error', { error: err.message });
    return errorFromException(err, true);
  }
};
