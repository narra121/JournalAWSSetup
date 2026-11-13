import type { ApiHandler } from '../../shared/types';
import { ddb } from '../../shared/dynamo';
import { QueryCommand } from '@aws-sdk/lib-dynamodb';
import { errorResponse, envelope, ErrorCodes } from '../../shared/validation';
import { makeLogger } from '../../shared/logger';
import { getUserId } from '../../shared/auth';
import { queryDailyStats } from '../../shared/dailyStats';

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

    // The counts are summed from DailyStats (one row per account and day), so they trail a trade write by the stream delay.
    const days = await queryDailyStats(userId, 'ALL', '0000-01-01', '9999-12-31', '#sk, #date, accountId, tradeCount');
    const tally = new Map<string, { tradeCount: number; lastTradeDate: string | null }>();
    for (const day of days) {
      if (!(day.tradeCount > 0)) continue;
      const t = tally.get(day.accountId) ?? { tradeCount: 0, lastTradeDate: null };
      t.tradeCount += day.tradeCount;
      if (!t.lastTradeDate || day.date > t.lastTradeDate) t.lastTradeDate = day.date;
      tally.set(day.accountId, t);
    }

    log.info('accounts retrieved', { count: accounts.length });
    
    return envelope({
      statusCode: 200,
      data: {
        accounts: accounts.map((acc) => ({ ...acc, tradeCount: tally.get(acc.accountId)?.tradeCount ?? 0, lastTradeDate: tally.get(acc.accountId)?.lastTradeDate ?? null })),
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
