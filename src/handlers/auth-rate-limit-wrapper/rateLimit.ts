import { ddb } from '../../shared/dynamo';
import { GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';

const TABLE = process.env.RATE_LIMIT_TABLE!;

export interface RateLimitOptions {
  key: string; // unique key (userId:route or ip:route)
  limit: number; // max in window
  windowSeconds: number; // ttl window
}

export async function checkRateLimit(opts: RateLimitOptions) {
  const now = Math.floor(Date.now() / 1000);
  const ttl = now + opts.windowSeconds;
  const key = opts.key;
  const res = await ddb.send(new GetCommand({ TableName: TABLE, Key: { key } }));
  let count = res.Item?.count || 0;
  if (count >= opts.limit) {
    return { allowed: false, retryAfter: res.Item?.ttl ? res.Item.ttl - now : opts.windowSeconds };
  }
  count += 1;
  await ddb.send(new PutCommand({ TableName: TABLE, Item: { key, count, ttl } }));
  return { allowed: true };
}
