import { ListObjectsV2Command, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import { fail } from '../../features/http';
import type { AppEnv } from '../types';

export const uploadRoutes = new Hono<AppEnv>();

const s3 = new S3Client({});

export const MAX_UPLOAD_BYTES = 2 * 1024 * 1024;
export const UPLOAD_URL_SECONDS = 300;
/** Screenshots one user may add per rolling 24 h (a trade holds at most 6). */
export const MAX_UPLOADS_PER_DAY = 100;
const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_LIST_PAGES = 10;
const EXTENSIONS: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' };

const invalid = (c: any, message: string) => fail(c, 400, 'VALIDATION_ERROR', message);

/** Objects the user put under `images/<userId>/upload/` in the last 24 h; counting stops once the daily limit is reached. */
async function uploadsToday(userId: string): Promise<number> {
  const since = Date.now() - DAY_MS;
  let count = 0;
  let token: string | undefined;
  for (let page = 0; page < MAX_LIST_PAGES; page++) {
    const res = await s3.send(new ListObjectsV2Command({ Bucket: process.env.IMAGES_BUCKET!, Prefix: `images/${userId}/upload/`, ContinuationToken: token }));
    count += (res.Contents ?? []).filter((o) => (o.LastModified?.getTime() ?? 0) > since).length;
    if (count >= MAX_UPLOADS_PER_DAY || !res.IsTruncated) break;
    token = res.NextContinuationToken;
  }
  return count;
}

/**
 * POST /v1/uploads/images { contentType, size } → presigned S3 PUT for one screenshot (png/jpeg/webp, at most 2 MiB).
 * The signature covers Content-Type and Content-Length, so the upload cannot exceed what was declared. A trade then
 * references the returned `key` (it must stay under the caller's own `images/<userId>/` prefix).
 */
uploadRoutes.post('/images', async (c) => {
  const body: any = await c.req.json().catch(() => null);
  const contentType = body?.contentType;
  const size = body?.size;
  if (typeof contentType !== 'string' || !(contentType in EXTENSIONS)) return invalid(c, 'Screenshots must be PNG, JPEG or WebP images.');
  if (!Number.isInteger(size) || size < 1 || size > MAX_UPLOAD_BYTES) return invalid(c, `Screenshots can be at most ${MAX_UPLOAD_BYTES / (1024 * 1024)} MB.`);

  if ((await uploadsToday(c.get('userId'))) >= MAX_UPLOADS_PER_DAY) {
    return fail(c, 429, 'RATE_LIMITED', 'You have uploaded a lot of screenshots today. Please try again tomorrow.', { retryAfter: 3600 });
  }

  const key = `images/${c.get('userId')}/upload/${randomUUID()}.${EXTENSIONS[contentType]}`;
  const url = await getSignedUrl(
    s3,
    new PutObjectCommand({ Bucket: process.env.IMAGES_BUCKET!, Key: key, ContentType: contentType, ContentLength: size }),
    { expiresIn: UPLOAD_URL_SECONDS, signableHeaders: new Set(['content-type', 'content-length']) },
  );
  return c.json({
    success: true,
    message: 'Success',
    data: { url, key, method: 'PUT', headers: { 'Content-Type': contentType }, expiresIn: UPLOAD_URL_SECONDS, maxBytes: MAX_UPLOAD_BYTES },
  });
});
