import { BatchWriteCommand } from '@aws-sdk/lib-dynamodb';
import type { Logger } from './logger';

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function jitteredDelay(baseDelayMs: number, attempt: number): number {
  const exponential = baseDelayMs * Math.pow(2, attempt - 1);
  return exponential + Math.random() * exponential;
}

type DdbLike = {
  send: (command: any) => Promise<any>;
};

export async function batchWritePutAll(opts: {
  ddb: DdbLike;
  tableName: string;
  items: any[];
  log?: Logger;
  maxRetries?: number;
  baseDelayMs?: number;
}) {
  const { ddb, tableName, log } = opts;
  const maxRetries = opts.maxRetries ?? 5;
  const baseDelayMs = opts.baseDelayMs ?? 50;

  const BATCH_LIMIT = 25; // DynamoDB BatchWriteItem max
  const allItems = opts.items ?? [];
  if (allItems.length === 0) return;

  // Chunk into groups of 25 and process chunks in parallel
  const chunks: any[][] = [];
  for (let i = 0; i < allItems.length; i += BATCH_LIMIT) {
    chunks.push(allItems.slice(i, i + BATCH_LIMIT));
  }

  await Promise.all(chunks.map(async (chunk) => {
    let remaining = [...chunk];
    let attempt = 0;

    while (remaining.length > 0) {
      const resp = await ddb.send(
        new BatchWriteCommand({
          RequestItems: {
            [tableName]: remaining.map((it) => ({ PutRequest: { Item: it } }))
          }
        })
      );

      const unprocessed = resp?.UnprocessedItems?.[tableName] ?? [];
      remaining = unprocessed
        .map((r: any) => r?.PutRequest?.Item)
        .filter(Boolean);

      if (remaining.length === 0) return;

      attempt++;
      log?.warn('batch write unprocessed items', {
        tableName,
        attempt,
        remaining: remaining.length
      });

      if (attempt > maxRetries) {
        throw new Error(`BatchWrite did not process all items after ${maxRetries} retries (remaining=${remaining.length})`);
      }

      await sleep(jitteredDelay(baseDelayMs, attempt));
    }
  }));
}

export async function batchWriteDeleteAll(opts: {
  ddb: DdbLike;
  tableName: string;
  keys: Record<string, any>[];
  log?: Logger;
  maxRetries?: number;
  baseDelayMs?: number;
}) {
  const { ddb, tableName, log } = opts;
  const maxRetries = opts.maxRetries ?? 5;
  const baseDelayMs = opts.baseDelayMs ?? 50;

  const BATCH_LIMIT = 25;
  const allKeys = opts.keys ?? [];
  if (allKeys.length === 0) return;

  const chunks: Record<string, any>[][] = [];
  for (let i = 0; i < allKeys.length; i += BATCH_LIMIT) {
    chunks.push(allKeys.slice(i, i + BATCH_LIMIT));
  }

  await Promise.all(chunks.map(async (chunk) => {
    let remaining = [...chunk];
    let attempt = 0;

    while (remaining.length > 0) {
      const resp = await ddb.send(
        new BatchWriteCommand({
          RequestItems: {
            [tableName]: remaining.map((key) => ({ DeleteRequest: { Key: key } }))
          }
        })
      );

      const unprocessed = resp?.UnprocessedItems?.[tableName] ?? [];
      remaining = unprocessed
        .map((r: any) => r?.DeleteRequest?.Key)
        .filter(Boolean);

      if (remaining.length === 0) return;

      attempt++;
      log?.warn('batch delete unprocessed items', {
        tableName,
        attempt,
        remaining: remaining.length
      });

      if (attempt > maxRetries) {
        throw new Error(`BatchDelete did not process all items after ${maxRetries} retries (remaining=${remaining.length})`);
      }

      await sleep(jitteredDelay(baseDelayMs, attempt));
    }
  }));
}
