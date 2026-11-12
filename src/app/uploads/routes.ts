import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import type { AppEnv } from '../types';

export const uploadRoutes = new Hono<AppEnv>();

const s3 = new S3Client({});

export const MAX_UPLOAD_BYTES = 2 * 1024 * 1024;
export const UPLOAD_URL_SECONDS = 300;
const EXTENSIONS: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' };

const fail = (c: any, message: string) => c.json({ success: false, message, errorCode: 'VALIDATION_ERROR', errorMessage: message }, 400);

/**
 * POST /v1/uploads/images { contentType, size } → presigned S3 PUT for one screenshot (png/jpeg/webp, at most 2 MiB).
 * The signature covers Content-Type and Content-Length, so the upload cannot exceed what was declared. A trade then
 * references the returned `key` (it must stay under the caller's own `images/<userId>/` prefix).
 */
uploadRoutes.post('/images', async (c) => {
  const body: any = await c.req.json().catch(() => null);
  const contentType = body?.contentType;
  const size = body?.size;
  if (typeof contentType !== 'string' || !(contentType in EXTENSIONS)) return fail(c, 'contentType must be image/png, image/jpeg or image/webp');
  if (!Number.isInteger(size) || size < 1 || size > MAX_UPLOAD_BYTES) return fail(c, `size must be between 1 and ${MAX_UPLOAD_BYTES} bytes (2 MiB)`);

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
