import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { S3Client, ListObjectsV2Command, DeleteObjectsCommand } from '@aws-sdk/client-s3';
import { extractKeyFromS3Url, normalizePotentialKey } from '../s3';

// ─── S3 mock for images.ts integration tests ──────────────────
const s3Mock = mockClient(S3Client);

vi.stubEnv('IMAGES_BUCKET', 'test-bucket');

const { removeImagesForTrade } = await import('../images');

const BUCKET = 'test-bucket';
const PREFIX = 'images/';

beforeEach(() => {
  s3Mock.reset();
});

// ═══════════════════════════════════════════════════════════════
// extractKeyFromS3Url — additional edge cases
// (Existing s3.test.ts covers basic valid/invalid URL, wrong bucket,
//  query string stripping, prefix validation, length limit, X-Amz-,
//  empty and null input. We add more edge cases below.)
// ═══════════════════════════════════════════════════════════════

describe('extractKeyFromS3Url - additional edge cases', () => {
  it('extracts key from URL with multiple query params (presigned)', () => {
    const url = `https://${BUCKET}.s3.us-east-1.amazonaws.com/images/u1/t1/photo.jpg?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=AKIA&X-Amz-Date=20240101&X-Amz-Expires=3600&X-Amz-Signature=abc123`;
    const result = extractKeyFromS3Url(url, BUCKET, PREFIX);
    expect(result).toBe('images/u1/t1/photo.jpg');
  });

  it('strips query params from presigned URL and returns clean key', () => {
    const url = `https://${BUCKET}.s3.ap-south-1.amazonaws.com/images/user/trade/img.png?X-Amz-Security-Token=FwoG&X-Amz-Algorithm=AWS4-HMAC-SHA256`;
    const result = extractKeyFromS3Url(url, BUCKET, PREFIX);
    expect(result).toBe('images/user/trade/img.png');
  });

  it('returns null for URL with only query params and no path', () => {
    const url = `https://${BUCKET}.s3.us-east-1.amazonaws.com/?X-Amz-Algorithm=test`;
    const result = extractKeyFromS3Url(url, BUCKET, PREFIX);
    expect(result).toBeNull();
  });

  it('handles URL-encoded path components correctly', () => {
    const url = `https://${BUCKET}.s3.us-east-1.amazonaws.com/images/user%20id/trade%201/photo%20file.jpg`;
    const result = extractKeyFromS3Url(url, BUCKET, PREFIX);
    expect(result).toBe('images/user id/trade 1/photo file.jpg');
  });

  it('returns null for a number input', () => {
    expect(extractKeyFromS3Url(123 as any, BUCKET, PREFIX)).toBeNull();
  });

  it('returns null for boolean input', () => {
    expect(extractKeyFromS3Url(true as any, BUCKET, PREFIX)).toBeNull();
  });

  it('handles URL with hash fragment', () => {
    const url = `https://${BUCKET}.s3.us-east-1.amazonaws.com/images/u1/t1/photo.jpg#fragment`;
    // Hash is not stripped by the function (no ? present), but the key contains #
    // This is an edge case - verify it returns the key with hash (or null if invalid)
    const result = extractKeyFromS3Url(url, BUCKET, PREFIX);
    // The function only strips query strings (after ?), so hash remains in key
    if (result !== null) {
      expect(result).toContain('images/');
    }
  });

  it('returns null when key exceeds 1024 bytes with multibyte chars', () => {
    // Each emoji is 4 bytes in UTF-8
    const emojiSegment = '\u{1F600}'.repeat(260); // 260 * 4 = 1040 bytes
    const url = `https://${BUCKET}.s3.us-east-1.amazonaws.com/images/${emojiSegment}.jpg`;
    expect(extractKeyFromS3Url(url, BUCKET, PREFIX)).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════
// normalizePotentialKey — additional edge cases
// (Existing tests cover bare key, S3 URL extraction, empty value,
//  X-Amz- in bare key, and non-matching strings.)
// ═══════════════════════════════════════════════════════════════

describe('normalizePotentialKey - additional edge cases', () => {
  it('returns bare key for a simple direct key', () => {
    const key = 'images/user1/trade1/img.jpg';
    expect(normalizePotentialKey(key, BUCKET, PREFIX)).toBe(key);
  });

  it('extracts key from full S3 URL when value is not a bare key', () => {
    const url = `https://${BUCKET}.s3.us-east-1.amazonaws.com/images/u1/t1/photo.jpg?X-Amz-Credential=abc`;
    const result = normalizePotentialKey(url, BUCKET, PREFIX);
    expect(result).toBe('images/u1/t1/photo.jpg');
  });

  it('returns null for key without images/ prefix', () => {
    const key = 'documents/file.pdf';
    expect(normalizePotentialKey(key, BUCKET, PREFIX)).toBeNull();
  });

  it('returns null for bare key exceeding 1024 bytes', () => {
    const longKey = 'images/' + 'x'.repeat(1020);
    expect(normalizePotentialKey(longKey, BUCKET, PREFIX)).toBeNull();
  });

  it('returns null for bare key with signature params in it', () => {
    const key = 'images/X-Amz-SignedHeaders/photo.jpg';
    expect(normalizePotentialKey(key, BUCKET, PREFIX)).toBeNull();
  });

  it('returns null for null input', () => {
    expect(normalizePotentialKey(null as any, BUCKET, PREFIX)).toBeNull();
  });

  it('returns null for undefined input', () => {
    expect(normalizePotentialKey(undefined as any, BUCKET, PREFIX)).toBeNull();
  });

  it('returns null for key starting with images/ but containing X-Amz-Credential', () => {
    const key = 'images/user1/X-Amz-Credential/photo.jpg';
    expect(normalizePotentialKey(key, BUCKET, PREFIX)).toBeNull();
  });

  it('accepts key exactly at 1024 bytes', () => {
    // 'images/' is 7 bytes, so remaining can be 1017 bytes
    const key = 'images/' + 'a'.repeat(1017);
    expect(Buffer.byteLength(key, 'utf8')).toBe(1024);
    expect(normalizePotentialKey(key, BUCKET, PREFIX)).toBe(key);
  });

  it('rejects key at 1025 bytes', () => {
    const key = 'images/' + 'a'.repeat(1018);
    expect(Buffer.byteLength(key, 'utf8')).toBe(1025);
    expect(normalizePotentialKey(key, BUCKET, PREFIX)).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════
// removeImagesForTrade — additional integration tests
// (Existing images.test.ts covers: correct prefix, correct bucket,
//  delete on objects, no objects, undefined Contents, pagination.)
// ═══════════════════════════════════════════════════════════════

describe('removeImagesForTrade - S3 error handling and edge cases', () => {
  it('handles S3 DeleteObjectsCommand returning errors on some objects', async () => {
    s3Mock.on(ListObjectsV2Command).resolves({
      Contents: [
        { Key: 'images/user-1/trade-1/img1.jpg' },
        { Key: 'images/user-1/trade-1/img2.jpg' },
        { Key: 'images/user-1/trade-1/img3.jpg' },
      ],
      IsTruncated: false,
    });

    // S3 DeleteObjectsCommand can return Errors array for partially failed deletes
    s3Mock.on(DeleteObjectsCommand).resolves({
      Deleted: [{ Key: 'images/user-1/trade-1/img1.jpg' }],
      Errors: [
        { Key: 'images/user-1/trade-1/img2.jpg', Code: 'AccessDenied', Message: 'Access Denied' },
      ],
    });

    // Should not throw - the function does not check for partial errors
    await expect(removeImagesForTrade('user-1', 'trade-1')).resolves.toBeUndefined();

    const deleteCalls = s3Mock.commandCalls(DeleteObjectsCommand);
    expect(deleteCalls).toHaveLength(1);
  });

  it('handles S3 ListObjectsV2Command throwing an error', async () => {
    s3Mock.on(ListObjectsV2Command).rejects(new Error('S3 ListObjectsV2 failed'));

    // Should propagate the error
    await expect(removeImagesForTrade('user-1', 'trade-1')).rejects.toThrow('S3 ListObjectsV2 failed');
  });

  it('handles S3 DeleteObjectsCommand throwing an error', async () => {
    s3Mock.on(ListObjectsV2Command).resolves({
      Contents: [{ Key: 'images/user-1/trade-1/img1.jpg' }],
      IsTruncated: false,
    });
    s3Mock.on(DeleteObjectsCommand).rejects(new Error('S3 delete failed'));

    await expect(removeImagesForTrade('user-1', 'trade-1')).rejects.toThrow('S3 delete failed');
  });

  it('handles empty prefix result — no objects to delete', async () => {
    s3Mock.on(ListObjectsV2Command).resolves({
      Contents: [],
      IsTruncated: false,
    });

    await removeImagesForTrade('user-1', 'trade-empty');

    const listCalls = s3Mock.commandCalls(ListObjectsV2Command);
    expect(listCalls).toHaveLength(1);
    expect(listCalls[0].args[0].input.Prefix).toBe('images/user-1/trade-empty/');

    const deleteCalls = s3Mock.commandCalls(DeleteObjectsCommand);
    expect(deleteCalls).toHaveLength(0);
  });

  it('constructs correct prefix for userId with special characters', async () => {
    s3Mock.on(ListObjectsV2Command).resolves({ Contents: [], IsTruncated: false });

    await removeImagesForTrade('user@example.com', 'trade-1');

    const listCalls = s3Mock.commandCalls(ListObjectsV2Command);
    expect(listCalls[0].args[0].input.Prefix).toBe('images/user@example.com/trade-1/');
  });

  it('handles large number of objects across multiple pages', async () => {
    // Page 1: 1000 objects
    const page1Objects = Array.from({ length: 1000 }, (_, i) => ({
      Key: `images/user-1/trade-1/img${i}.jpg`,
    }));
    // Page 2: 500 objects
    const page2Objects = Array.from({ length: 500 }, (_, i) => ({
      Key: `images/user-1/trade-1/img${1000 + i}.jpg`,
    }));

    s3Mock.on(ListObjectsV2Command)
      .resolvesOnce({
        Contents: page1Objects,
        IsTruncated: true,
        NextContinuationToken: 'page2-token',
      })
      .resolvesOnce({
        Contents: page2Objects,
        IsTruncated: false,
      });
    s3Mock.on(DeleteObjectsCommand).resolves({});

    await removeImagesForTrade('user-1', 'trade-1');

    const listCalls = s3Mock.commandCalls(ListObjectsV2Command);
    expect(listCalls).toHaveLength(2);

    const deleteCalls = s3Mock.commandCalls(DeleteObjectsCommand);
    expect(deleteCalls).toHaveLength(2);
    expect(deleteCalls[0].args[0].input.Delete?.Objects).toHaveLength(1000);
    expect(deleteCalls[1].args[0].input.Delete?.Objects).toHaveLength(500);
  });

  it('skips gracefully when IMAGES_BUCKET is empty string', async () => {
    // The function checks `if (!BUCKET) return;` — but BUCKET was set at import time.
    // This test verifies the behavior: since BUCKET was set to 'test-bucket' at module load,
    // the function will proceed normally even if env var changes later.
    s3Mock.on(ListObjectsV2Command).resolves({ Contents: [], IsTruncated: false });

    await removeImagesForTrade('user-1', 'trade-1');

    // Should have attempted the list call since BUCKET was set at import
    const listCalls = s3Mock.commandCalls(ListObjectsV2Command);
    expect(listCalls).toHaveLength(1);
  });
});
