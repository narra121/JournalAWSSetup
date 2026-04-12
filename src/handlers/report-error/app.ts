import { APIGatewayProxyHandlerV2 } from 'aws-lambda';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { createHash } from 'crypto';
import { errorReportSchema } from '../../schemas';
import { getValidator, formatErrors, envelope, errorResponse, ErrorCodes } from '../../shared/validation';
import { getUserId } from '../../shared/auth';
import { checkRateLimit } from '../auth-rate-limit-wrapper/rateLimit';

const ERROR_REPORTS_BUCKET = process.env.ERROR_REPORTS_BUCKET!;
const s3 = new S3Client({});
const MAX_BODY_BYTES = 200 * 1024; // 200KB

export const handler: APIGatewayProxyHandlerV2 = async (event) => {
  try {
    // 1. Check body exists and size
    if (!event.body) {
      return errorResponse(400, ErrorCodes.VALIDATION_ERROR, 'Missing body');
    }
    if (Buffer.byteLength(event.body, 'utf8') > MAX_BODY_BYTES) {
      return errorResponse(413, ErrorCodes.VALIDATION_ERROR, 'Payload too large (max 200KB)');
    }

    // 2. Rate limit by IP
    const sourceIp = event.requestContext?.http?.sourceIp || 'unknown';
    const rateLimitResult = await checkRateLimit({
      key: `error-report:${sourceIp}`,
      limit: 10,
      windowSeconds: 3600,
    });
    if (!rateLimitResult.allowed) {
      return errorResponse(429, ErrorCodes.VALIDATION_ERROR, 'Rate limit exceeded');
    }

    // 3. Parse and validate
    let data: any;
    try {
      data = JSON.parse(event.body);
    } catch {
      return errorResponse(400, ErrorCodes.VALIDATION_ERROR, 'Invalid JSON');
    }

    const validate = getValidator(errorReportSchema, 'errorReport');
    if (!validate(data)) {
      const details = formatErrors(validate.errors);
      return errorResponse(400, ErrorCodes.VALIDATION_ERROR, 'Invalid error report', details);
    }

    // 4. Extract userId (optional — may not be authenticated)
    const userId = getUserId(event) || data.userId || 'anonymous';

    // 5. Generate S3 key
    const now = new Date();
    const dateStr = now.toISOString().slice(0, 10); // yyyy-MM-dd
    const timestamp = now.toISOString().replace(/[:.]/g, '-');
    const hash = createHash('sha256').update(event.body).digest('hex').slice(0, 8);
    const key = `errors/${dateStr}/${userId}/${timestamp}-${hash}.json`;

    // 6. Write to S3
    await s3.send(new PutObjectCommand({
      Bucket: ERROR_REPORTS_BUCKET,
      Key: key,
      Body: event.body,
      ContentType: 'application/json',
    }));

    return envelope({ statusCode: 202, message: 'Error report received' });
  } catch (error: any) {
    // Never expose internal errors — always return 202
    console.error('report-error handler failed', { error: error.message });
    return envelope({ statusCode: 202, message: 'Error report received' });
  }
};
