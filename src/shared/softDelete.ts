import { GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { ddb } from './dynamo';

/** A deleted trade stays restorable for this long; the table's TTL attribute removes it afterwards. */
export const SOFT_DELETE_DAYS = 30;

export const isDeleted = (item: { deletedAt?: unknown } | null | undefined): boolean => !!item?.deletedAt;

const table = () => process.env.TRADES_TABLE!;

/**
 * Marks a trade deleted (kept for SOFT_DELETE_DAYS). The idempotency key moves to `deletedIdempotencyKey`, so
 * importing the same file again creates the trade anew instead of being skipped as a duplicate.
 * Returns the trade as it was, or null when it does not exist (or is already deleted).
 */
export async function softDeleteTrade(userId: string, tradeId: string, now: Date = new Date()): Promise<Record<string, any> | null> {
  const current = (await ddb.send(new GetCommand({ TableName: table(), Key: { userId, tradeId } }))).Item;
  if (!current || isDeleted(current)) return null;

  const names: Record<string, string> = { '#ttl': 'ttl', '#deletedAt': 'deletedAt' };
  const values: Record<string, any> = {
    ':now': now.toISOString(),
    ':ttl': Math.floor(now.getTime() / 1000) + SOFT_DELETE_DAYS * 86400,
  };
  let update = 'SET #deletedAt = :now, #ttl = :ttl';
  if (current.idempotencyKey) {
    names['#idem'] = 'idempotencyKey';
    names['#delIdem'] = 'deletedIdempotencyKey';
    values[':idem'] = current.idempotencyKey;
    update += ', #delIdem = :idem REMOVE #idem';
  }
  try {
    await ddb.send(
      new UpdateCommand({
        TableName: table(),
        Key: { userId, tradeId },
        ConditionExpression: 'attribute_exists(tradeId) AND attribute_not_exists(#deletedAt)',
        UpdateExpression: update,
        ExpressionAttributeNames: names,
        ExpressionAttributeValues: values,
      }),
    );
  } catch (err: any) {
    if (err.name === 'ConditionalCheckFailedException') return null;
    throw err;
  }
  return current;
}

/** Brings a soft-deleted trade back. Returns false when there is nothing to restore. */
export async function restoreTrade(userId: string, tradeId: string): Promise<boolean> {
  const current = (await ddb.send(new GetCommand({ TableName: table(), Key: { userId, tradeId } }))).Item;
  if (!current || !isDeleted(current)) return false;

  const names: Record<string, string> = { '#deletedAt': 'deletedAt', '#ttl': 'ttl', '#updatedAt': 'updatedAt' };
  const values: Record<string, any> = { ':now': new Date().toISOString() };
  let update = 'SET #updatedAt = :now REMOVE #deletedAt, #ttl';
  if (current.deletedIdempotencyKey) {
    names['#idem'] = 'idempotencyKey';
    names['#delIdem'] = 'deletedIdempotencyKey';
    values[':idem'] = current.deletedIdempotencyKey;
    update = 'SET #updatedAt = :now, #idem = :idem REMOVE #deletedAt, #ttl, #delIdem';
  }
  try {
    await ddb.send(
      new UpdateCommand({
        TableName: table(),
        Key: { userId, tradeId },
        ConditionExpression: 'attribute_exists(#deletedAt)',
        UpdateExpression: update,
        ExpressionAttributeNames: names,
        ExpressionAttributeValues: values,
      }),
    );
  } catch (err: any) {
    if (err.name === 'ConditionalCheckFailedException') return false;
    throw err;
  }
  return true;
}
