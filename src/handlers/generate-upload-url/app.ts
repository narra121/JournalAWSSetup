import { APIGatewayProxyHandlerV2 } from 'aws-lambda';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { v4 as uuid } from 'uuid';
import { ddb } from '../../shared/dynamo';
import { GetCommand } from '@aws-sdk/lib-dynamodb';
import { envelope, errorResponse, ErrorCodes } from '../../shared/validation';

const BUCKET = process.env.IMAGES_BUCKET!;
const TRADES_TABLE = process.env.TRADES_TABLE!;
const s3 = new S3Client({});

export const handler: APIGatewayProxyHandlerV2 = async (event) => {
  try {
    const userId = (event.requestContext as any)?.authorizer?.jwt?.claims?.sub;
    if (!userId) return errorResponse(401, ErrorCodes.UNAUTHORIZED, 'Unauthorized');
    const qs = event.queryStringParameters || {};
    const tradeId = qs.tradeId;
    if (!tradeId) return errorResponse(400, ErrorCodes.VALIDATION_ERROR, 'Missing tradeId');
    const contentType = qs.contentType || 'image/jpeg';
    if (!contentType.startsWith('image/')) return errorResponse(400, ErrorCodes.VALIDATION_ERROR, 'Invalid contentType');

    // Ownership / existence check
    const existing = await ddb.send(new GetCommand({ TableName: TRADES_TABLE, Key: { userId, tradeId } }));
    if (!existing.Item) return errorResponse(404, ErrorCodes.NOT_FOUND, 'Trade not found');

    const key = `images/${userId}/${tradeId}/${uuid()}` + extensionFor(contentType);
    const command = new PutObjectCommand({ Bucket: BUCKET, Key: key, ContentType: contentType });
    const url = await getSignedUrl(s3, command, { expiresIn: 300 });
    return envelope({ statusCode: 200, data: { url, key } });
  } catch (e) {
    console.error(e);
    return errorResponse(500, ErrorCodes.INTERNAL_ERROR, 'Internal error');
  }
};

function extensionFor(ct: string) {
  if (ct === 'image/png') return '.png';
  if (ct === 'image/gif') return '.gif';
  return '.jpg';
}
