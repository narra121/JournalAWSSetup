import { BatchWriteCommand, GetCommand, PutCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
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
