import type { ApiHandler } from '../../shared/types';
import { ddb } from '../../shared/dynamo';
import { QueryCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { errorResponse, envelope, ErrorCodes } from '../../shared/validation';
import { makeLogger } from '../../shared/logger';
import { getUserId } from '../../shared/auth';
import { accountTally } from '../../shared/dailyStats';

const ACCOUNTS_TABLE = process.env.ACCOUNTS_TABLE!;

export const handler: ApiHandler = async (event) => {
  const userId = getUserId(event);
  const log = makeLogger({ requestId: event.requestContext.requestId, userId });
  
  log.info('list-accounts invoked');
  
  if (!userId) {
    log.warn('unauthorized request');
    return errorResponse(401, ErrorCodes.UNAUTHORIZED, 'Unauthorized');
  }

  try {
    const accounts: any[] = [];
    let lastEvaluatedKey: any;
    do {
      const result = await ddb.send(new QueryCommand({
        TableName: ACCOUNTS_TABLE,
        KeyConditionExpression: 'userId = :userId',
        ExpressionAttributeValues: {
          ':userId': userId
        },
        ExclusiveStartKey: lastEvaluatedKey
      }));
      if (result.Items) accounts.push(...result.Items);
      lastEvaluatedKey = result.LastEvaluatedKey;
    } while (lastEvaluatedKey);
    
    // Totals per currency: balances in different currencies must not be added up.
    const totalsByCurrency = new Map<string, { balance: number; pnl: number }>();
    for (const acc of accounts) {
      const currency = String(acc.currency ?? 'UNKNOWN').toUpperCase();
      const totals = totalsByCurrency.get(currency) ?? { balance: 0, pnl: 0 };
      totals.balance += acc.balance || 0;
      totals.pnl += (acc.balance || 0) - (acc.initialBalance || 0);
      totalsByCurrency.set(currency, totals);
    }
    // The single-number totals stay only when they are meaningful, i.e. all accounts share one currency.
    const single = totalsByCurrency.size <= 1 ? [...totalsByCurrency.values()][0] ?? { balance: 0, pnl: 0 } : null;

    // update-stats and rebuild-stats-job keep tradeCount and lastTradeDate on the account. One created before they did
    // has neither: it is summed from its DailyStats days once and stored, so no manual backfill is needed.
    await Promise.all(accounts.filter((acc) => typeof acc.tradeCount !== 'number').map(async (acc) => {
      const { tradeCount, lastTradeDate } = await accountTally(userId, acc.accountId);
      acc.tradeCount = tradeCount;
      acc.lastTradeDate = lastTradeDate;
      try {
        await ddb.send(new UpdateCommand({
          TableName: ACCOUNTS_TABLE,
          Key: { userId, accountId: acc.accountId },
          UpdateExpression: `SET #tradeCount = :count${lastTradeDate ? ', #lastTradeDate = :last' : ''}`,
          // Skipped when update-stats or the rebuild stored the counters meanwhile.
          ConditionExpression: 'attribute_exists(userId) AND attribute_not_exists(#tradeCount)',
          ExpressionAttributeNames: { '#tradeCount': 'tradeCount', ...(lastTradeDate ? { '#lastTradeDate': 'lastTradeDate' } : {}) },
          ExpressionAttributeValues: { ':count': tradeCount, ...(lastTradeDate ? { ':last': lastTradeDate } : {}) },
        }));
      } catch (e: any) {
        if (e.name !== 'ConditionalCheckFailedException') log.warn('could not store trade count', { accountId: acc.accountId, error: e.message });
      }
    }));

    log.info('accounts retrieved', { count: accounts.length });
    
    return envelope({
      statusCode: 200,
      data: {
        accounts: accounts.map((acc) => ({ ...acc, lastTradeDate: acc.lastTradeDate ?? null })),
        ...(single ? { totalBalance: single.balance, totalPnl: single.pnl } : {}),
        totalsByCurrency: Object.fromEntries(totalsByCurrency)
      },
      message: 'Accounts retrieved'
    });
  } catch (error: any) {
    log.error('failed to list accounts', { error: error.message });
    return errorResponse(500, ErrorCodes.INTERNAL_ERROR, 'Failed to retrieve accounts');
  }
};
