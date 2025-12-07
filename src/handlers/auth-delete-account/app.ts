import { APIGatewayProxyHandlerV2 } from 'aws-lambda';
import { ddb } from '../../shared/dynamo';
import { QueryCommand, DeleteCommand } from '@aws-sdk/lib-dynamodb';
import { S3Client, ListObjectsV2Command, DeleteObjectsCommand } from '@aws-sdk/client-s3';
import { CognitoIdentityProviderClient, AdminDeleteUserCommand } from '@aws-sdk/client-cognito-identity-provider';

const TRADES_TABLE = process.env.TRADES_TABLE!;
const STATS_TABLE = process.env.TRADE_STATS_TABLE!;
const BUCKET = process.env.IMAGES_BUCKET!;
const USER_POOL_ID = process.env.USER_POOL_ID!;
const s3 = new S3Client({});
const cognito = new CognitoIdentityProviderClient({});

export const handler: APIGatewayProxyHandlerV2 = async (event) => {
  const rc: any = event.requestContext as any;
  const userId = rc?.authorizer?.jwt?.claims?.sub;
  const username = rc?.authorizer?.jwt?.claims?.email; // assuming email-as-username
  if (!userId) return resp(401, null, { code: 'UNAUTHORIZED', message: 'Unauthorized' });

  try {
    // Delete all trade items (paginate query + delete)
    let lastKey: any;
    do {
      const q = await ddb.send(new QueryCommand({
        TableName: TRADES_TABLE,
        KeyConditionExpression: 'userId = :u',
        ExpressionAttributeValues: { ':u': userId },
        ExclusiveStartKey: lastKey
      }));
      for (const it of q.Items || []) {
        await ddb.send(new DeleteCommand({ TableName: TRADES_TABLE, Key: { userId, tradeId: it.tradeId } }));
      }
      lastKey = q.LastEvaluatedKey;
    } while (lastKey);

    // Delete stats row
    await ddb.send(new DeleteCommand({ TableName: STATS_TABLE, Key: { userId } }));

    // Delete images prefix
    let cont: string | undefined;
    do {
      const list = await s3.send(new ListObjectsV2Command({ Bucket: BUCKET, Prefix: `images/${userId}/` }));
      if (list.Contents && list.Contents.length) {
        const Objects = list.Contents.map(o => ({ Key: o.Key! }));
        await s3.send(new DeleteObjectsCommand({ Bucket: BUCKET, Delete: { Objects } }));
      }
      cont = list.NextContinuationToken;
    } while (cont);

    // Delete Cognito user (admin)
    if (username) {
      await cognito.send(new AdminDeleteUserCommand({ UserPoolId: USER_POOL_ID, Username: username }));
    }

    return resp(200, { message: 'Account deleted' }, null);
  } catch (e: any) {
    console.error(e);
    return resp(500, null, { code: 'DELETE_FAILED', message: e.message || 'Failed to delete account' });
  }
};

function resp(statusCode: number, data: any, error: any) {
  return { statusCode, body: JSON.stringify({ data, error, meta: null }) };
}
