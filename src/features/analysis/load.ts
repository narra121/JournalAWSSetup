import { QueryCommand } from '@aws-sdk/lib-dynamodb';
import { ddb } from '../../shared/dynamo';
import { getUserTimeZone, isCalendarDay } from '../../shared/timezone';
import type { TradeRow, TradeSource } from '../trades-repo';

export interface AccountInfo {
  accountId: string;
  /** upper case; 'UNKNOWN' when the account has none */
  currency: string;
  initialBalance: number | null;
}

export interface AnalysisDeps {
  trades: TradeSource;
  accounts(userId: string): Promise<AccountInfo[]>;
  /** the user's IANA zone preference, null when none is set */
  timeZone(userId: string): Promise<string | null>;
}

export async function dynamoAccounts(userId: string): Promise<AccountInfo[]> {
  const out: AccountInfo[] = [];
  let startKey: Record<string, unknown> | undefined;
  do {
    const r = await ddb.send(
      new QueryCommand({
        TableName: process.env.ACCOUNTS_TABLE!,
        KeyConditionExpression: 'userId = :u',
        ExpressionAttributeValues: { ':u': userId },
        ProjectionExpression: 'accountId, currency, initialBalance',
        ExclusiveStartKey: startKey,
      }),
    );
    for (const it of r.Items ?? []) {
      out.push({ accountId: String(it.accountId), currency: String(it.currency ?? 'UNKNOWN').toUpperCase(), initialBalance: typeof it.initialBalance === 'number' && it.initialBalance > 0 ? it.initialBalance : null });
    }
    startKey = r.LastEvaluatedKey;
  } while (startKey);
  return out;
}

/** The stored preference; a failed read counts as none (GET /stats does the same). */
export const userTimeZone = (userId: string): Promise<string | null> => getUserTimeZone(userId).catch(() => null);

/** The stored zone when it is a valid IANA name, else UTC (what GET /stats uses, so the two pages agree). */
export function resolveTimeZone(tz: string | null | undefined): string {
  if (!tz) return 'UTC';
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return tz;
  } catch {
    return 'UTC';
  }
}

export interface AnalysisScope {
  /** an account id, or ALL / null for every account */
  accountId: string | null;
  from: string;
  to: string;
}

export type LoadedInput =
  | { ok: true; trades: TradeRow[]; truncated: boolean; currency: string | null; timeZone: string; startingBalance: number | null; ruleTexts: Map<string, string> }
  | { ok: false; status: 400 | 404 | 422; code: string; message: string; details?: Record<string, unknown> };

/**
 * Loads one currency's trades for the analysis functions (the API routes and the chat tools share it). Across all
 * accounts the trades must share one currency: otherwise 422 MIXED_CURRENCY with the currencies.
 */
export async function loadAnalysisInput(deps: AnalysisDeps, userId: string, scope: AnalysisScope, opts: { ruleTexts?: boolean } = {}): Promise<LoadedInput> {
  if (!isCalendarDay(scope.from) || !isCalendarDay(scope.to) || scope.from > scope.to) {
    return { ok: false, status: 400, code: 'VALIDATION_ERROR', message: 'from and to must be days (YYYY-MM-DD), from on or before to.' };
  }
  const all = !scope.accountId || scope.accountId === 'ALL';
  const [accounts, zone] = await Promise.all([deps.accounts(userId), deps.timeZone(userId)]);
  const timeZone = resolveTimeZone(zone);
  if (!all && !accounts.some((a) => a.accountId === scope.accountId)) return { ok: false, status: 404, code: 'NOT_FOUND', message: "We couldn't find that account." };
  const loaded = await deps.trades.loadTrades(userId, { from: scope.from, to: scope.to, timeZone, accountId: all ? null : scope.accountId });
  const byId = new Map(accounts.map((a) => [a.accountId, a]));
  const used = all ? [...new Set(loaded.trades.map((t) => t.accountId).filter((id): id is string => !!id && byId.has(id)))].map((id) => byId.get(id)!) : [byId.get(scope.accountId!)!];
  const currencies = [...new Set(used.map((a) => a.currency))].sort();
  if (currencies.length > 1) {
    return { ok: false, status: 422, code: 'MIXED_CURRENCY', message: `These trades are in ${currencies.join(' and ')}. Choose one account, or accounts in one currency, so amounts are not added across currencies.`, details: { currencies } };
  }
  const balances = used.map((a) => a.initialBalance);
  const accountCurrencies = new Set(accounts.map((a) => a.currency));
  return {
    ok: true,
    trades: loaded.trades,
    truncated: loaded.truncated,
    currency: currencies[0] ?? (accountCurrencies.size === 1 ? [...accountCurrencies][0] : null),
    timeZone,
    startingBalance: balances.length && balances.every((b) => b != null) ? balances.reduce((s, b) => s! + b!, 0)! : null,
    ruleTexts: opts.ruleTexts ? await deps.trades.loadRuleTexts(userId) : new Map(),
  };
}
