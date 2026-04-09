import { describe, it, expect } from 'vitest';
import { extractKeyFromS3Url, normalizePotentialKey } from '../s3.js';

const BUCKET = 'my-test-bucket';
const PREFIX = 'images/';

// ─── extractKeyFromS3Url ────────────────────────────────────────

describe('extractKeyFromS3Url', () => {
  it('extracts key from a valid presigned S3 URL', () => {
    const url = `https://${BUCKET}.s3.us-east-1.amazonaws.com/images/acc1/trade1/photo.jpg?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=AKIA...`;
    const result = extractKeyFromS3Url(url, BUCKET, PREFIX);
    expect(result).toBe('images/acc1/trade1/photo.jpg');
  });

  it('returns null for a non-S3 URL', () => {
    const url = 'https://example.com/images/photo.jpg';
    expect(extractKeyFromS3Url(url, BUCKET, PREFIX)).toBeNull();
  });

  it('returns null for wrong bucket', () => {
    const url = `https://other-bucket.s3.us-east-1.amazonaws.com/images/photo.jpg`;
    expect(extractKeyFromS3Url(url, BUCKET, PREFIX)).toBeNull();
  });

  it('strips query string from the key', () => {
    const url = `https://${BUCKET}.s3.us-east-1.amazonaws.com/images/acc1/trade1/photo.jpg?some=param`;
    const result = extractKeyFromS3Url(url, BUCKET, PREFIX);
    expect(result).toBe('images/acc1/trade1/photo.jpg');
    expect(result).not.toContain('?');
  });

  it('returns null if key does not start with allowedPrefix', () => {
    const url = `https://${BUCKET}.s3.us-east-1.amazonaws.com/documents/file.pdf?X-Amz-Algorithm=test`;
    expect(extractKeyFromS3Url(url, BUCKET, PREFIX)).toBeNull();
  });

  it('returns null if key exceeds 1024 bytes', () => {
    const longSegment = 'a'.repeat(1020);
    const url = `https://${BUCKET}.s3.us-east-1.amazonaws.com/images/${longSegment}.jpg`;
    expect(extractKeyFromS3Url(url, BUCKET, PREFIX)).toBeNull();
  });

  it('returns null if key contains X-Amz- (malformed strip)', () => {
    // Simulate a case where query params were not properly stripped
    const url = `https://${BUCKET}.s3.us-east-1.amazonaws.com/images/X-Amz-Credential/photo.jpg`;
    expect(extractKeyFromS3Url(url, BUCKET, PREFIX)).toBeNull();
  });

  it('returns null for empty input', () => {
    expect(extractKeyFromS3Url('', BUCKET, PREFIX)).toBeNull();
  });

  it('returns null for null-like input', () => {
    expect(extractKeyFromS3Url(null as any, BUCKET, PREFIX)).toBeNull();
    expect(extractKeyFromS3Url(undefined as any, BUCKET, PREFIX)).toBeNull();
  });
});

// ─── normalizePotentialKey ──────────────────────────────────────

describe('normalizePotentialKey', () => {
  it('returns bare key if it already starts with prefix', () => {
    const key = 'images/acc1/trade1/photo.jpg';
    expect(normalizePotentialKey(key, BUCKET, PREFIX)).toBe(key);
  });

  it('extracts key from S3 URL if value is not a bare key', () => {
    const url = `https://${BUCKET}.s3.us-east-1.amazonaws.com/images/acc1/trade1/photo.jpg?X-Amz-Algorithm=test`;
    const result = normalizePotentialKey(url, BUCKET, PREFIX);
    expect(result).toBe('images/acc1/trade1/photo.jpg');
  });

  it('returns null for empty value', () => {
    expect(normalizePotentialKey('', BUCKET, PREFIX)).toBeNull();
  });

  it('returns null if bare key contains X-Amz-', () => {
    const key = 'images/X-Amz-Credential/photo.jpg';
    expect(normalizePotentialKey(key, BUCKET, PREFIX)).toBeNull();
  });

  it('returns null for value that is neither a bare key nor valid S3 URL', () => {
    expect(normalizePotentialKey('random-string', BUCKET, PREFIX)).toBeNull();
  });
});
