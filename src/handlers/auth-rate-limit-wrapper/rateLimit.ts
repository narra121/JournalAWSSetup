import { ddb } from '../../shared/dynamo';
import { UpdateCommand } from '@aws-sdk/lib-dynamodb';

const TABLE = process.env.RATE_LIMIT_TABLE!;

export interface RateLimitOptions {
  key: string; // unique key (userId:route or ip:route)
  limit: number; // max in window
  windowSeconds: number; // ttl window
}

export async function checkRateLimit(opts: RateLimitOptions) {
  const now = Math.floor(Date.now() / 1000);
  const newTtl = now + opts.windowSeconds;
  const key = opts.key;

  // Atomic increment: ADD count +1, SET ttl only if not already set
  const res = await ddb.send(new UpdateCommand({
    TableName: TABLE,
    Key: { key },
    UpdateExpression: 'ADD #count :one SET #ttl = if_not_exists(#ttl, :newTtl)',
    ExpressionAttributeNames: { '#count': 'count', '#ttl': 'ttl' },
    ExpressionAttributeValues: { ':one': 1, ':newTtl': newTtl },
    ReturnValues: 'ALL_NEW',
  }));

  const item = res.Attributes!;

  // If the TTL is in the past (stale item from expired DynamoDB TTL), reset it
  if (item.ttl < now) {
    const freshTtl = now + opts.windowSeconds;
    const resetRes = await ddb.send(new UpdateCommand({
      TableName: TABLE,
      Key: { key },
      UpdateExpression: 'SET #count = :one, #ttl = :freshTtl',
      ExpressionAttributeNames: { '#count': 'count', '#ttl': 'ttl' },
      ExpressionAttributeValues: { ':one': 1, ':freshTtl': freshTtl },
      ReturnValues: 'ALL_NEW',
    }));
    return { allowed: true };
  }

  // Check if over limit
  if (item.count > opts.limit) {
    return { allowed: false, retryAfter: item.ttl - now };
  }

  return { allowed: true };
}
