import { BatchGetCommand, GetCommand, QueryCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import type { Context, MiddlewareHandler } from 'hono';
import { fail } from '../../features/http';
import { ddb } from '../../shared/dynamo';
import type { AppEnv } from '../types';
import { FREE_ACCOUNT_LIMIT } from './entitlements';
import { planRequired } from './responses';

/** Trades with no account use this id and are never restricted. */
const UNASSIGNED = '-1';

export async function listAccountIds(userId: string): Promise<string[]> {
  const ids: string[] = [];
  let lastKey: Record<string, any> | undefined;
  do {
    const res = await ddb.send(
      new QueryCommand({
        TableName: process.env.ACCOUNTS_TABLE!,
        KeyConditionExpression: 'userId = :u',
        ExpressionAttributeValues: { ':u': userId },
        ProjectionExpression: 'accountId',
        ExclusiveStartKey: lastKey,
      }),
    );
    ids.push(...(res.Items ?? []).map((i) => i.accountId as string));
    lastKey = res.LastEvaluatedKey;
  } while (lastKey);
  return ids;
}

/**
 * Accounts the caller may write to. `null` means all of them: unlimited plan, or at most 2 accounts.
 * Above the free limit only the (≤ 2) chosen accounts are writable; none until they are chosen.
 */
export async function writableAccounts(c: Context<AppEnv>): Promise<string[] | null> {
  if (c.get('entitlements').features.unlimited_accounts) return null;
  const all = await listAccountIds(c.get('userId'));
  if (all.length <= FREE_ACCOUNT_LIMIT) return null;
  const chosen = (c.get('subscription')?.writableAccountIds as string[] | undefined) ?? [];
  return chosen.filter((id) => all.includes(id)).slice(0, FREE_ACCOUNT_LIMIT);
}

/** `POST /accounts`: the free plan holds at most 2 accounts (existing ones are never touched). */
export function accountLimit(): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const entitlements = c.get('entitlements');
    if (!entitlements.features.unlimited_accounts) {
      const count = (await listAccountIds(c.get('userId'))).length;
      if (count >= FREE_ACCOUNT_LIMIT) return planRequired(c, 'unlimited_accounts', entitlements, { limit: FREE_ACCOUNT_LIMIT });
    }
    await next();
  };
}

/**
 * Guards writes by account: everything that changes a trade or an account except deleting an account, which stays open
 * as the way out of the over-limit state. `accountsOf` returns the accounts a request touches (read from a clone of the
 * body, so the handler still receives it). Unassigned trades and a request that names no account are allowed.
 */
export function writableGuard(accountsOf: (c: Context<AppEnv>, body: any) => Promise<string[]> | string[]): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const writable = await writableAccounts(c);
    if (writable !== null) {
      const body = await c.req.raw.clone().json().catch(() => null);
      const touched = (await accountsOf(c, body)).filter((id) => id && id !== UNASSIGNED);
      if (touched.some((id) => !writable.includes(id))) {
        return planRequired(c, 'unlimited_accounts', c.get('entitlements'), { limit: FREE_ACCOUNT_LIMIT, allowedAccountIds: writable });
      }
    }
    await next();
  };
}

/** Accounts named by a create body: `accountIds`, `accountId`, or those of every bulk `items[]` entry. */
export function accountsInCreateBody(_c: Context<AppEnv>, body: any): string[] {
  const of = (t: any): string[] => (Array.isArray(t?.accountIds) ? t.accountIds : t?.accountId ? [t.accountId] : []);
  return Array.isArray(body?.items) ? body.items.flatMap(of) : of(body);
}

/** Accounts a trade update ends up on: those in the body, else the stored trade's account. */
export async function accountsInTradeUpdate(c: Context<AppEnv>, body: any): Promise<string[]> {
  const named = accountsInCreateBody(c, body);
  if (named.length) return named;
  const res = await ddb.send(
    new GetCommand({ TableName: process.env.TRADES_TABLE!, Key: { userId: c.get('userId'), tradeId: c.req.param('tradeId')! } }),
  );
  return res.Item?.accountId ? [res.Item.accountId] : [];
}

/** The delete, bulk-delete and bulk-update handlers reject more ids than this, so the guard does not look them up. */
const MAX_TRADE_IDS = 200;

/**
 * The stored accounts of the named trades (soft-deleted ones too: restore names them). Unprocessed BatchGet keys are
 * retried; if some stay unprocessed the request fails instead of passing with trades of a read-only account unchecked.
 */
async function storedAccountsOf(c: Context<AppEnv>, tradeIds: unknown): Promise<string[]> {
  const table = process.env.TRADES_TABLE!;
  const ids = [...new Set(Array.isArray(tradeIds) ? tradeIds.filter((id): id is string => typeof id === 'string' && !!id) : [])];
  const accounts = new Set<string>();
  if (ids.length > MAX_TRADE_IDS) return [];
  for (let i = 0; i < ids.length; i += 100) {
    let keys: Record<string, any>[] = ids.slice(i, i + 100).map((tradeId) => ({ userId: c.get('userId'), tradeId }));
    for (let attempt = 0; keys.length > 0 && attempt < 4; attempt++) {
      if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, 50 * 2 ** attempt));
      const res = await ddb.send(new BatchGetCommand({ RequestItems: { [table]: { Keys: keys, ProjectionExpression: 'accountId' } } }));
      for (const it of res.Responses?.[table] ?? []) if (it.accountId) accounts.add(it.accountId);
      keys = (res.UnprocessedKeys?.[table]?.Keys as Record<string, any>[] | undefined) ?? [];
    }
    if (keys.length > 0) throw new Error('Could not read every trade to check account access');
  }
  return [...accounts];
}

/** Accounts a bulk update ends on: the new `set.accountId` plus the stored account of every listed trade. */
export async function accountsInBulkUpdate(c: Context<AppEnv>, body: any): Promise<string[]> {
  const stored = await storedAccountsOf(c, body?.tradeIds);
  return typeof body?.set?.accountId === 'string' ? [body.set.accountId, ...stored] : stored;
}

/** Accounts a bulk delete or restore touches: the stored account of every listed trade. */
export const accountsInTradeIds = (c: Context<AppEnv>, body: any): Promise<string[]> => storedAccountsOf(c, body?.tradeIds);

/** Account of the trade a `DELETE /trades/{tradeId}` removes. */
export const accountsInTradeDelete = (c: Context<AppEnv>): Promise<string[]> => storedAccountsOf(c, [c.req.param('tradeId')]);

/** Account that `PUT /accounts/{accountId}` and its `/status` change. */
export const accountsInAccountUpdate = (c: Context<AppEnv>): string[] => [c.req.param('accountId')!];

/** `PUT /me/writable-accounts`: choose which (≤ 2) accounts stay writable on the free plan. */
export async function saveWritableAccounts(c: Context<AppEnv>, accountIds: unknown) {
  const userId = c.get('userId');
  if (!Array.isArray(accountIds) || accountIds.some((id) => typeof id !== 'string') || new Set(accountIds).size !== accountIds.length) {
    return fail(c, 400, 'VALIDATION_ERROR', 'Choose each account at most once.');
  }
  if (!c.get('entitlements').features.unlimited_accounts && accountIds.length > FREE_ACCOUNT_LIMIT) {
    return planRequired(c, 'unlimited_accounts', c.get('entitlements'), { limit: FREE_ACCOUNT_LIMIT });
  }
  const owned = await listAccountIds(userId);
  const unknown = (accountIds as string[]).filter((id) => !owned.includes(id));
  if (unknown.length) {
    return fail(c, 400, 'VALIDATION_ERROR', unknown.length === 1 ? "One of those accounts doesn't exist." : "Some of those accounts don't exist.");
  }
  await ddb.send(
    new UpdateCommand({
      TableName: process.env.SUBSCRIPTIONS_TABLE!,
      Key: { userId },
      UpdateExpression: 'SET writableAccountIds = :ids, updatedAt = :now',
      ExpressionAttributeValues: { ':ids': accountIds, ':now': new Date().toISOString() },
    }),
  );
  return c.json({ success: true, message: 'Success', data: { writableAccountIds: accountIds } });
}
