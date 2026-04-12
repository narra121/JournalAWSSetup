import { S3Client, ListObjectsV2Command, DeleteObjectsCommand } from '@aws-sdk/client-s3';

const s3 = new S3Client({});
const BUCKET = process.env.IMAGES_BUCKET!;

export async function removeImagesForTrade(userId: string, tradeId: string) {
  if (!BUCKET) return; // gracefully skip if not configured
  const prefix = `images/${userId}/${tradeId}/`;

  // Collect all keys first
  const allKeys: { Key: string }[] = [];
  let token: string | undefined;
  do {
    const list = await s3.send(new ListObjectsV2Command({ Bucket: BUCKET, Prefix: prefix, ContinuationToken: token }));
    if (list.Contents) {
      allKeys.push(...list.Contents.filter(o => o.Key).map(o => ({ Key: o.Key! })));
    }
    token = list.IsTruncated ? list.NextContinuationToken : undefined;
  } while (token);

  if (allKeys.length === 0) return;

  // Delete in parallel chunks of 1000 (S3 DeleteObjects limit per call)
  const chunks: { Key: string }[][] = [];
  for (let i = 0; i < allKeys.length; i += 1000) {
    chunks.push(allKeys.slice(i, i + 1000));
  }

  await Promise.all(
    chunks.map(chunk =>
      s3.send(new DeleteObjectsCommand({
        Bucket: BUCKET,
        Delete: { Objects: chunk, Quiet: true },
      }))
    )
  );
}
