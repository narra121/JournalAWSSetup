// Utility helpers related to S3 object key handling
// Ensures we never treat a full presigned URL (including query params) as the raw S3 key.

/**
 * Attempt to extract a clean S3 object key from a (possibly presigned) S3 HTTPS URL.
 * Returns null if the URL does not appear to reference the provided bucket or
 * the derived key does not match expected prefix constraints.
 */
export function extractKeyFromS3Url(url: string, bucket: string, allowedPrefix = 'images/') : string | null {
  if (!url || typeof url !== 'string') return null;
  const hostNeedle = '.amazonaws.com/';
  const idx = url.indexOf(hostNeedle);
  if (idx === -1) return null;
  if (!url.includes(`${bucket}.s3.`)) return null; // ensure it's our bucket
  let keyWithQuery = url.substring(idx + hostNeedle.length);
  // Strip query string if present
  const qIdx = keyWithQuery.indexOf('?');
  if (qIdx !== -1) keyWithQuery = keyWithQuery.substring(0, qIdx);
  // Decode URI components safely
  let key: string;
  try { key = decodeURIComponent(keyWithQuery); } catch { key = keyWithQuery; }
  // Enforce prefix & max length (S3 limit = 1024 bytes)
  if (!key.startsWith(allowedPrefix)) return null;
  if (Buffer.byteLength(key, 'utf8') > 1024) return null;
  // Disallow accidental inclusion of signature parameters (should have been stripped)
  if (key.includes('X-Amz-')) return null;
  return key;
}

/**
 * Given either a direct key (starting with allowedPrefix) or a full S3 URL (possibly presigned),
 * return the sanitized key or null if invalid.
 */
export function normalizePotentialKey(value: string, bucket: string, allowedPrefix = 'images/'): string | null {
  if (!value) return null;
  if (value.startsWith(allowedPrefix) && Buffer.byteLength(value, 'utf8') <= 1024 && !value.includes('X-Amz-')) {
    return value; // already a bare key
  }
  return extractKeyFromS3Url(value, bucket, allowedPrefix);
}
