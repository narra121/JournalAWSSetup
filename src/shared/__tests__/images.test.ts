import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { S3Client, ListObjectsV2Command, DeleteObjectsCommand, CopyObjectCommand } from '@aws-sdk/client-s3';

const s3Mock = mockClient(S3Client);

vi.stubEnv('IMAGES_BUCKET', 'test-bucket');

const { removeImagesForTrade, adoptUploads, ownsImageKey, uploadPrefix } = await import('../images');

beforeEach(() => {
  s3Mock.reset();
});

describe('removeImagesForTrade', () => {
  it('lists objects with the correct prefix', async () => {
    s3Mock.on(ListObjectsV2Command).resolves({ Contents: [], IsTruncated: false });

    await removeImagesForTrade('user-42', 'trade-99');

    const listCalls = s3Mock.commandCalls(ListObjectsV2Command);
    expect(listCalls).toHaveLength(1);
    expect(listCalls[0].args[0].input.Prefix).toBe('images/user-42/trade-99/');
  });

  it('uses the correct bucket name from the IMAGES_BUCKET env var', async () => {
    s3Mock.on(ListObjectsV2Command).resolves({ Contents: [], IsTruncated: false });

    await removeImagesForTrade('user-1', 'trade-1');

    const listCalls = s3Mock.commandCalls(ListObjectsV2Command);
    expect(listCalls).toHaveLength(1);
    expect(listCalls[0].args[0].input.Bucket).toBe('test-bucket');
  });

  it('deletes S3 objects when images exist', async () => {
    s3Mock.on(ListObjectsV2Command).resolves({
      Contents: [
        { Key: 'images/user-1/trade-1/img1.jpg' },
        { Key: 'images/user-1/trade-1/img2.png' },
        { Key: 'images/user-1/trade-1/img3.webp' },
      ],
      IsTruncated: false,
    });
    s3Mock.on(DeleteObjectsCommand).resolves({});

    await removeImagesForTrade('user-1', 'trade-1');

    const deleteCalls = s3Mock.commandCalls(DeleteObjectsCommand);
    expect(deleteCalls).toHaveLength(1);
    expect(deleteCalls[0].args[0].input.Delete?.Objects).toEqual([
      { Key: 'images/user-1/trade-1/img1.jpg' },
      { Key: 'images/user-1/trade-1/img2.png' },
      { Key: 'images/user-1/trade-1/img3.webp' },
    ]);
    expect(deleteCalls[0].args[0].input.Delete?.Quiet).toBe(true);
  });

  it('handles no images gracefully without calling DeleteObjectsCommand', async () => {
    s3Mock.on(ListObjectsV2Command).resolves({ Contents: [], IsTruncated: false });

    await removeImagesForTrade('user-1', 'trade-1');

    const deleteCalls = s3Mock.commandCalls(DeleteObjectsCommand);
    expect(deleteCalls).toHaveLength(0);
  });

  it('handles Contents being undefined without throwing', async () => {
    s3Mock.on(ListObjectsV2Command).resolves({ Contents: undefined, IsTruncated: false });

    await removeImagesForTrade('user-1', 'trade-1');

    const deleteCalls = s3Mock.commandCalls(DeleteObjectsCommand);
    expect(deleteCalls).toHaveLength(0);
  });

  it('handles pagination via IsTruncated and ContinuationToken', async () => {
    s3Mock.on(ListObjectsV2Command)
      .resolvesOnce({
        Contents: [
          { Key: 'images/user-1/trade-1/img1.jpg' },
          { Key: 'images/user-1/trade-1/img2.jpg' },
        ],
        IsTruncated: true,
        NextContinuationToken: 'token1',
      })
      .resolvesOnce({
        Contents: [{ Key: 'images/user-1/trade-1/img3.jpg' }],
        IsTruncated: false,
      });
    s3Mock.on(DeleteObjectsCommand).resolves({});

    await removeImagesForTrade('user-1', 'trade-1');

    // Should have made 2 list calls
    const listCalls = s3Mock.commandCalls(ListObjectsV2Command);
    expect(listCalls).toHaveLength(2);

    // Second list call should use the ContinuationToken
    expect(listCalls[1].args[0].input.ContinuationToken).toBe('token1');

    // All keys collected first, then deleted in a single batch (total < 1000)
    const deleteCalls = s3Mock.commandCalls(DeleteObjectsCommand);
    expect(deleteCalls).toHaveLength(1);
    expect(deleteCalls[0].args[0].input.Delete?.Objects).toHaveLength(3);
  });
});

describe('screenshots uploaded before a trade exists (H10)', () => {
  it('the upload prefix is one literal prefix per user, outside the trade prefixes', () => {
    expect(uploadPrefix('user-1')).toBe('images/upload/user-1/');
    expect(ownsImageKey('user-1', 'images/upload/user-1/a.png')).toBe(true);
    expect(ownsImageKey('user-1', 'images/user-1/trade-1/a.png')).toBe(true);
    expect(ownsImageKey('user-1', 'images/upload/user-2/a.png')).toBe(false);
    expect(ownsImageKey('user-1', 'images/user-2/trade-1/a.png')).toBe(false);
  });

  it('adoptUploads copies only upload keys under the trade and returns the new keys', async () => {
    s3Mock.on(CopyObjectCommand).resolves({});
    const out = await adoptUploads('user-1', [
      { id: 'a', key: 'images/upload/user-1/a.png', description: 'd' },
      { id: 'b', key: 'images/user-1/trade-1/b.png' },
      { id: 'c', url: 'https://example.com/c.png' },
    ], 'trade-9');
    expect(out).toEqual([
      { id: 'a', key: 'images/user-1/trade-9/a.png', description: 'd' },
      { id: 'b', key: 'images/user-1/trade-1/b.png' },
      { id: 'c', url: 'https://example.com/c.png' },
    ]);
    const copies = s3Mock.commandCalls(CopyObjectCommand);
    expect(copies).toHaveLength(1);
    expect(copies[0].args[0].input).toMatchObject({ Bucket: 'test-bucket', CopySource: 'test-bucket/images/upload/user-1/a.png', Key: 'images/user-1/trade-9/a.png' });
    expect(s3Mock.commandCalls(DeleteObjectsCommand)).toHaveLength(0);
  });

  it('an adopted copy lies under the prefix removeImagesForTrade lists, which is what the TTL purge and account delete call', async () => {
    s3Mock.on(CopyObjectCommand).resolves({});
    const [adopted] = await adoptUploads('user-1', [{ key: 'images/upload/user-1/a.png' }], 'trade-9');
    s3Mock.on(ListObjectsV2Command).resolves({ Contents: [{ Key: adopted.key }], IsTruncated: false });
    s3Mock.on(DeleteObjectsCommand).resolves({});
    await removeImagesForTrade('user-1', 'trade-9');
    expect(s3Mock.commandCalls(ListObjectsV2Command)[0].args[0].input.Prefix).toBe('images/user-1/trade-9/');
    expect(adopted.key.startsWith('images/user-1/trade-9/')).toBe(true);
    expect(s3Mock.commandCalls(DeleteObjectsCommand)[0].args[0].input.Delete?.Objects).toEqual([{ Key: adopted.key }]);
  });
});
