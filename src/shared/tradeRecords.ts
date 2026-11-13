import { BatchGetCommand } from '@aws-sdk/lib-dynamodb';
import { ddb } from './dynamo';

/** Loads full records for index rows (BatchGet in chunks of 100, retrying unprocessed keys); returns them by tradeId. */
export async function loadFullRecords(userId: string, keyRows: Record<string, any>[]): Promise<Map<string, any>> {
  const table = process.env.TRADES_TABLE!;
  const found = new Map<string, any>();
  for (let i = 0; i < keyRows.length; i += 100) {
    let keys: Record<string, any>[] = keyRows.slice(i, i + 100).map((r) => ({ userId, tradeId: r.tradeId }));
    for (let attempt = 0; keys.length > 0 && attempt < 4; attempt++) {
      if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, 50 * Math.pow(2, attempt)));
      const res = await ddb.send(new BatchGetCommand({ RequestItems: { [table]: { Keys: keys } } }));
      for (const it of res.Responses?.[table] ?? []) found.set(it.tradeId, it);
      keys = (res.UnprocessedKeys?.[table]?.Keys as Record<string, any>[] | undefined) ?? [];
    }
    if (keys.length > 0) throw new IncompleteLoadError();
  }
  return found;
}

export class IncompleteLoadError extends Error {
  constructor() {
    super('Could not load all trade records');
    this.name = 'IncompleteLoadError';
  }
}
