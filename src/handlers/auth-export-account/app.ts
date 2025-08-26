import { APIGatewayProxyHandlerV2 } from 'aws-lambda';
import { ddb } from '../../shared/dynamo';
import { QueryCommand, GetCommand } from '@aws-sdk/lib-dynamodb';

const TRADES_TABLE = process.env.TRADES_TABLE!;
const STATS_TABLE = process.env.TRADE_STATS_TABLE!;

export const handler: APIGatewayProxyHandlerV2 = async (event) => {
  const rc: any = event.requestContext as any;
  const userId = rc?.authorizer?.jwt?.claims?.sub;
  if (!userId) return resp(401, { message: 'Unauthorized' });
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
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json', 'Content-Disposition': 'attachment; filename="journal-export.json"' },
      body: JSON.stringify({ trades: all, stats: stats.Item || null, exportedAt: new Date().toISOString() })
    };
  } catch (e: any) { console.error(e); return resp(500, { message: e.message || 'Failed to export' }); }
};

function resp(statusCode: number, body: any) { return { statusCode, body: JSON.stringify(body) }; }
