import { BatchWriteCommand, GetCommand, PutCommand, QueryCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { ddb } from '../shared/dynamo';

/** AiData row: PK userId, SK sk (`INSIGHT#…`, `CHAT#…`, `MSG#…`, `IMPORT#…`). Every key starts with the caller's userId. */
export interface AiItem {
  userId: string;
  sk: string;
  [attr: string]: unknown;
}

export interface QueryOpts {
  prefix: string;
  limit: number;
  newestFirst?: boolean;
  startKey?: Record<string, unknown>;
}

export interface AiStore {
  put(item: AiItem): Promise<void>;
  get(userId: string, sk: string): Promise<AiItem | null>;
  query(userId: string, o: QueryOpts): Promise<{ items: AiItem[]; lastKey?: Record<string, unknown> }>;
  delete(userId: string, sks: string[]): Promise<void>;
  /** Writes `item` unless one with that key exists and has not expired (`expiresAt`, epoch ms, is not before `nowMs`). False when someone else holds it. */
  putIfFree(item: AiItem & { expiresAt: number }, nowMs: number): Promise<boolean>;
  /** Sets attributes of an existing item, leaving the others (counters included) as stored. */
  patch(userId: string, sk: string, set: Record<string, unknown>): Promise<void>;
  /** Atomically adds `by` to a number of an existing item; with `below`, only while the stored value is under it. False when the item is missing or the cap is reached. */
  addToCount(userId: string, sk: string, attr: string, by: number, below?: number): Promise<boolean>;
}

const table = () => {
  const t = process.env.AI_DATA_TABLE;
  if (!t) throw new Error('AI_DATA_TABLE not configured');
  return t;
};

export const dynamoAiStore: AiStore = {
  async put(item) {
    await ddb.send(new PutCommand({ TableName: table(), Item: item }));
  },
  async get(userId, sk) {
    const r = await ddb.send(new GetCommand({ TableName: table(), Key: { userId, sk } }));
    return (r.Item as AiItem) ?? null;
  },
  async query(userId, o) {
    const r = await ddb.send(
      new QueryCommand({
        TableName: table(),
        KeyConditionExpression: 'userId = :u AND begins_with(sk, :p)',
        ExpressionAttributeValues: { ':u': userId, ':p': o.prefix },
        ScanIndexForward: !o.newestFirst,
        Limit: o.limit,
        ExclusiveStartKey: o.startKey,
      }),
    );
    return { items: (r.Items as AiItem[]) ?? [], lastKey: r.LastEvaluatedKey };
  },
  async putIfFree(item, nowMs) {
    try {
      await ddb.send(
        new PutCommand({
          TableName: table(),
          Item: item,
          ConditionExpression: 'attribute_not_exists(sk) OR expiresAt < :now',
          ExpressionAttributeValues: { ':now': nowMs },
        }),
      );
      return true;
    } catch (e: any) {
      if (e?.name === 'ConditionalCheckFailedException') return false;
      throw e;
    }
  },
  async patch(userId, sk, set) {
    const names = Object.fromEntries(Object.keys(set).map((k, i) => [`#a${i}`, k]));
    const values = Object.fromEntries(Object.values(set).map((v, i) => [`:v${i}`, v]));
    await ddb.send(
      new UpdateCommand({
        TableName: table(),
        Key: { userId, sk },
        ConditionExpression: 'attribute_exists(sk)',
        UpdateExpression: `SET ${Object.keys(names).map((n, i) => `${n} = :v${i}`).join(', ')}`,
        ExpressionAttributeNames: names,
        ExpressionAttributeValues: values,
      }),
    );
  },
  async addToCount(userId, sk, attr, by, below) {
    try {
      await ddb.send(
        new UpdateCommand({
          TableName: table(),
          Key: { userId, sk },
          ConditionExpression: below === undefined ? 'attribute_exists(sk)' : 'attribute_exists(sk) AND (attribute_not_exists(#a) OR #a < :below)',
          UpdateExpression: 'ADD #a :by',
          ExpressionAttributeNames: { '#a': attr },
          ExpressionAttributeValues: { ':by': by, ...(below === undefined ? {} : { ':below': below }) },
        }),
      );
      return true;
    } catch (e: any) {
      if (e?.name === 'ConditionalCheckFailedException') return false;
      throw e;
    }
  },
  async delete(userId, sks) {
    for (let i = 0; i < sks.length; i += 25) {
      let pending: any[] = sks.slice(i, i + 25).map((sk) => ({ DeleteRequest: { Key: { userId, sk } } }));
      for (let attempt = 0; pending.length && attempt < 5; attempt++) {
        const r = await ddb.send(new BatchWriteCommand({ RequestItems: { [table()]: pending } }));
        pending = r.UnprocessedItems?.[table()] ?? [];
      }
      if (pending.length) throw new Error('AiData batch delete left unprocessed items');
    }
  },
};

/** base64url(LastEvaluatedKey) bound to the user: a cursor from another user's listing is rejected. */
export function encodeCursor(userId: string, key: Record<string, unknown> | undefined): string | null {
  return key ? Buffer.from(JSON.stringify({ u: userId, k: key })).toString('base64url') : null;
}

export function decodeCursor(userId: string, cursor: string | undefined): Record<string, unknown> | undefined | 'invalid' {
  if (!cursor) return undefined;
  try {
    const v = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    return v?.u === userId && v.k && typeof v.k === 'object' && v.k.userId === userId ? v.k : 'invalid';
  } catch {
    return 'invalid';
  }
}
