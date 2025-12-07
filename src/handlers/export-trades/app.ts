import { APIGatewayProxyHandlerV2 } from 'aws-lambda';
import { ddb } from '../../shared/dynamo';
import { QueryCommand } from '@aws-sdk/lib-dynamodb';
import { errorResponse, ErrorCodes } from '../../shared/validation';
import { makeLogger } from '../../shared/logger';

const TRADES_TABLE = process.env.TRADES_TABLE!;

function convertToCSV(trades: any[]): string {
  if (trades.length === 0) return '';

  const headers = [
    'Symbol', 'Direction', 'Quantity', 'Entry Price', 'Exit Price',
    'Stop Loss', 'Take Profit', 'Open Date', 'Close Date',
    'Outcome', 'PnL', 'Net PnL', 'Commission', 'Fees',
    'Strategy', 'Session', 'Market Condition', 'Notes'
  ];

  const rows = trades.map(t => [
    t.symbol || '',
    t.side || '',
    t.quantity || '',
    t.entryPrice || '',
    t.exitPrice || '',
    t.stopLoss || '',
    t.takeProfit || '',
    t.openDate || '',
    t.closeDate || '',
    t.outcome || '',
    t.pnl || '',
    t.netPnl || '',
    t.commission || '',
    t.fees || '',
    t.setupType || '',
    t.tradingSession || '',
    t.marketCondition || '',
    (t.preTradeNotes || '') + ' ' + (t.postTradeNotes || '')
  ].map(v => `"${String(v).replace(/"/g, '""')}"`).join(','));

  return [headers.join(','), ...rows].join('\n');
}

export const handler: APIGatewayProxyHandlerV2 = async (event) => {
  const rc: any = event.requestContext as any;
  const claims = rc?.authorizer?.jwt?.claims || {};
  const userId = claims.sub;
  const log = makeLogger({ requestId: event.requestContext.requestId, userId });
  
  log.info('export-trades invoked');
  
  if (!userId) {
    log.warn('unauthorized request');
    return errorResponse(401, ErrorCodes.UNAUTHORIZED, 'Unauthorized');
  }

  const accountId = event.queryStringParameters?.accountId;
  const format = event.queryStringParameters?.format || 'csv';

  try {
    const result = await ddb.send(new QueryCommand({
      TableName: TRADES_TABLE,
      KeyConditionExpression: 'userId = :userId',
      ExpressionAttributeValues: {
        ':userId': userId
      }
    }));

    let trades = result.Items || [];
    
    // Filter by account if specified
    if (accountId && trades.length > 0) {
      trades = trades.filter(t => 
        t.accountIds && Array.isArray(t.accountIds) && t.accountIds.includes(accountId)
      );
    }

    // Sort by date
    trades.sort((a, b) => {
      const dateA = a.openDate || '';
      const dateB = b.openDate || '';
      return dateB.localeCompare(dateA);
    });

    let content: string;
    let contentType: string;
    let filename: string;

    if (format === 'json') {
      content = JSON.stringify(trades, null, 2);
      contentType = 'application/json';
      filename = `trades-${new Date().toISOString().split('T')[0]}.json`;
    } else {
      content = convertToCSV(trades);
      contentType = 'text/csv';
      filename = `trades-${new Date().toISOString().split('T')[0]}.csv`;
    }

    log.info('trades exported', { count: trades.length, format });
    
    return {
      statusCode: 200,
      headers: {
        'Content-Type': contentType,
        'Content-Disposition': `attachment; filename="${filename}"`
      },
      body: content
    };
  } catch (error: any) {
    log.error('failed to export trades', { error: error.message });
    return errorResponse(500, ErrorCodes.INTERNAL_ERROR, 'Failed to export trades');
  }
};
