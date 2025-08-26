import { S3Client, ListObjectsV2Command, DeleteObjectsCommand } from '@aws-sdk/client-s3';

const s3 = new S3Client({});
const BUCKET = process.env.IMAGES_BUCKET!;

export async function removeImagesForTrade(userId: string, tradeId: string) {
  if (!BUCKET) return; // gracefully skip if not configured
  const prefix = `images/${userId}/${tradeId}/`;
  let token: string | undefined;
  do {
    const list = await s3.send(new ListObjectsV2Command({ Bucket: BUCKET, Prefix: prefix, ContinuationToken: token }));
    token = list.IsTruncated ? list.NextContinuationToken : undefined;
    if (list.Contents && list.Contents.length) {
      const objects = list.Contents.map(o => ({ Key: o.Key! }));
      await s3.send(new DeleteObjectsCommand({ Bucket: BUCKET, Delete: { Objects: objects, Quiet: true } }));
    }
  } while (token);
}
