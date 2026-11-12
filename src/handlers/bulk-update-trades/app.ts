import { BatchGetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { ddb } from '../../shared/dynamo';
import { getUserId } from '../../shared/auth';
import { makeLogger } from '../../shared/logger';
import type { ApiHandler } from '../../shared/types';
import { tagsError } from '../../shared/tags';
import { envelope, errorResponse, ErrorCodes } from '../../shared/validation';

const TRADES_TABLE = process.env.TRADES_TABLE!;

export const MAX_BULK_UPDATE = 200;
/** Scalar fields `set` may change, and the list fields `add` / `remove` may change. */
export const SETTABLE_FIELDS = ['setupType', 'tradingSession', 'marketCondition', 'tradeNotes', 'outcome', 'accountId'] as const;
export const LIST_FIELDS = ['mistakes', 'lessons', 'tags', 'newsEvents', 'brokenRuleIds'] as const;

const isStringList = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === 'string');

async function loadTrades(userId: string, tradeIds: string[]): Promise<Map<string, any>> {
  const found = new Map<string, any>();
  for (let i = 0; i < tradeIds.length; i += 100) {
    let keys: Record<string, any>[] = tradeIds.slice(i, i + 100).map((tradeId) => ({ userId, tradeId }));
    for (let attempt = 0; keys.length > 0 && attempt < 4; attempt++) {
      if (attempt > 0) await new Promise((r) => setTimeout(r, 50 * 2 ** attempt));
      const res = await ddb.send(new BatchGetCommand({ RequestItems: { [TRADES_TABLE]: { Keys: keys } } }));
      for (const it of res.Responses?.[TRADES_TABLE] ?? []) if (!it.deletedAt) found.set(it.tradeId, it);
      keys = (res.UnprocessedKeys?.[TRADES_TABLE]?.Keys as Record<string, any>[] | undefined) ?? [];
    }
  }
  return found;
}

/**
 * POST /v1/trades/bulk-update { tradeIds, set?, add?, remove? }: applies one change set to up to 200 of the caller's
 * trades. `set` replaces scalar fields, `add` / `remove` merge into the list fields. Missing trades are reported, not fatal.
 */
export const handler: ApiHandler = async (event) => {
  const userId = getUserId(event);
  const log = makeLogger({ requestId: event.requestContext.requestId, userId });
  try {
    if (!userId) return errorResponse(401, ErrorCodes.UNAUTHORIZED, 'Unauthorized');

    let body: any;
    try {
      body = JSON.parse(event.body || 'null');
    } catch {
      return errorResponse(400, ErrorCodes.VALIDATION_ERROR, 'Invalid JSON');
    }
    if (!body || typeof body !== 'object') return errorResponse(400, ErrorCodes.VALIDATION_ERROR, 'Missing body');

    const { tradeIds, set = {}, add = {}, remove = {} } = body;
    if (!isStringList(tradeIds) || tradeIds.length === 0 || new Set(tradeIds).size !== tradeIds.length) {
      return errorResponse(400, ErrorCodes.VALIDATION_ERROR, 'tradeIds must be a non-empty list of distinct ids');
    }
    if (tradeIds.length > MAX_BULK_UPDATE) {
      return errorResponse(400, ErrorCodes.VALIDATION_ERROR, `Too many trades (max ${MAX_BULK_UPDATE})`);
    }
    for (const [name, obj, allowed] of [['set', set, SETTABLE_FIELDS], ['add', add, LIST_FIELDS], ['remove', remove, LIST_FIELDS]] as const) {
      if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return errorResponse(400, ErrorCodes.VALIDATION_ERROR, `${name} must be an object`);
      const unknown = Object.keys(obj).filter((k) => !(allowed as readonly string[]).includes(k));
      if (unknown.length) return errorResponse(400, ErrorCodes.VALIDATION_ERROR, `${name} cannot change: ${unknown.join(', ')}`);
    }
    for (const k of Object.keys(set)) {
      if (set[k] !== null && typeof set[k] !== 'string') return errorResponse(400, ErrorCodes.VALIDATION_ERROR, `set.${k} must be a string or null`);
    }
    for (const group of [add, remove]) {
      for (const k of Object.keys(group)) if (!isStringList(group[k])) return errorResponse(400, ErrorCodes.VALIDATION_ERROR, `${k} must be a list of strings`);
    }
    if (!Object.keys(set).length && !Object.keys(add).length && !Object.keys(remove).length) {
      return errorResponse(400, ErrorCodes.VALIDATION_ERROR, 'Nothing to change');
    }

    const trades = await loadTrades(userId, tradeIds);
    const notFound = tradeIds.filter((id) => !trades.has(id));
    const updated: string[] = [];
    const failed: { tradeId: string; message: string }[] = [];

    const apply = async (tradeId: string) => {
      const trade = trades.get(tradeId);
      const changes: Record<string, any> = { ...set };
      for (const field of new Set([...Object.keys(add), ...Object.keys(remove)])) {
        const current: string[] = Array.isArray(trade[field]) ? trade[field] : [];
        const dropped = new Set<string>(remove[field] ?? []);
        const merged = [...new Set([...current, ...(add[field] ?? [])])].filter((v) => !dropped.has(v));
        if (field === 'tags') {
          const problem = tagsError(merged);
          if (problem) {
            failed.push({ tradeId, message: problem });
            return;
          }
        }
        changes[field] = merged;
      }
      const names: Record<string, string> = { '#updatedAt': 'updatedAt' };
      const values: Record<string, any> = { ':updatedAt': new Date().toISOString() };
      const sets = ['#updatedAt = :updatedAt'];
      Object.entries(changes).forEach(([field, value], i) => {
        names[`#f${i}`] = field;
        values[`:v${i}`] = value;
        sets.push(`#f${i} = :v${i}`);
      });
      try {
        await ddb.send(new UpdateCommand({
          TableName: TRADES_TABLE,
          Key: { userId, tradeId },
          ConditionExpression: 'attribute_exists(tradeId)',
          UpdateExpression: `SET ${sets.join(', ')}`,
          ExpressionAttributeNames: names,
          ExpressionAttributeValues: values,
        }));
        updated.push(tradeId);
      } catch (e: any) {
        if (e.name === 'ConditionalCheckFailedException') notFound.push(tradeId);
        else failed.push({ tradeId, message: e.message || 'error' });
      }
    };

    const existing = tradeIds.filter((id) => trades.has(id));
    for (let i = 0; i < existing.length; i += 10) await Promise.all(existing.slice(i, i + 10).map(apply));

    log.info('bulk update done', { requested: tradeIds.length, updated: updated.length, notFound: notFound.length, failed: failed.length });
    return envelope({ statusCode: 200, data: { updated: updated.length, updatedIds: updated, notFound, failed }, message: 'Trades updated' });
  } catch (e: any) {
    log.error('bulk-update-trades failed', { error: e.message, stack: e.stack });
    return errorResponse(500, ErrorCodes.INTERNAL_ERROR, 'Internal error');
  }
};
