import { normalizePotentialKey } from './s3';

/**
 * A stored trade as every trade endpoint returns it: image ids are the S3 keys (what GET /v1/images/<key> takes),
 * the legacy `accountIds` list is gone and `achievedRiskRewardRatio` is at least null. Returns a new object.
 */
export function presentTrade<T extends Record<string, any>>(item: T): T {
  const { accountIds: _legacy, ...rest } = item as Record<string, any>;
  if (rest.achievedRiskRewardRatio === undefined) rest.achievedRiskRewardRatio = null;
  if (Array.isArray(rest.images)) {
    rest.images = rest.images.map((im: any) => {
      const key = im.key || normalizePotentialKey(im.url, process.env.IMAGES_BUCKET!);
      return key ? { ...im, id: key, key } : { ...im, id: im.id || im.key || '' };
    });
  }
  return rest as T;
}
