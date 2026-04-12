import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { S3Client, ListObjectsV2Command, DeleteObjectsCommand } from '@aws-sdk/client-s3';

const s3Mock = mockClient(S3Client);

vi.stubEnv('IMAGES_BUCKET', 'test-bucket');

const { removeImagesForTrade } = await import('../images');

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
