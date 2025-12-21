import { APIGatewayProxyHandlerV2 } from 'aws-lambda';
import { ddb } from '../../shared/dynamo';
import { QueryCommand, GetCommand } from '@aws-sdk/lib-dynamodb';
import { envelope, errorResponse, ErrorCodes } from '../../shared/validation';

const TRADES_TABLE = process.env.TRADES_TABLE!;
const STATS_TABLE = process.env.TRADE_STATS_TABLE!;

export const handler: APIGatewayProxyHandlerV2 = async (event) => {
  const rc: any = event.requestContext as any;
  const userId = rc?.authorizer?.jwt?.claims?.sub;
  if (!userId) return errorResponse(401, ErrorCodes.UNAUTHORIZED, 'Unauthorized');
  try {
    const all: any[] = [];
    let lastKey: any;
    do {
      const q = await ddb.send(new QueryCommand({
        TableName: TRADES_TABLE,
        KeyConditionExpression: 'userId = :u',
        ExpressionAttributeValues: { ':u': userId },
        ExclusiveStartKey: lastKey
      }));
      all.push(...(q.Items || []));
      lastKey = q.LastEvaluatedKey;
    } while (lastKey);
    const stats = await ddb.send(new GetCommand({ TableName: STATS_TABLE, Key: { userId } }));
    
    // Custom response for file download, but wrapping in envelope structure for consistency if possible, 
    // though usually file downloads are raw. 
    // However, the user asked for consistency. 
    // If this is a JSON API that returns the data, we use envelope.
    // If it's a file download, we might need headers.
    // The original code returned a JSON body with headers for attachment.
    
    const body = {
      success: true,
      message: 'Export successful',
      data: {
        trades: all,
        stats: stats.Item || null,
        exportedAt: new Date().toISOString(),
      }
    };

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json', 'Content-Disposition': 'attachment; filename="journal-export.json"' },
      body: JSON.stringify(body)
    };
  } catch (e: any) { console.error(e); return errorResponse(500, ErrorCodes.INTERNAL_ERROR, e.message || 'Failed to export'); }
};
