import { resolveTimeZone, type AccountInfo } from '../analysis/load';
import { loadFullRecords } from '../../shared/tradeRecords';
import { toTradeRow, type TradeRow, type TradeSource } from '../trades-repo';
import { addDays } from './history';
import { BASELINE_DAYS } from './review';

export interface LoadDeps {
  trades: TradeSource;
  accounts(userId: string): Promise<AccountInfo[]>;
  /** the user's IANA zone preference, null when none is set */
  timeZone(userId: string): Promise<string | null>;
}

export interface ReviewScope {
  /** an account id, or null/ALL for every account */
  accountId: string | null;
  /** with every account: only the accounts in this currency */
  currency?: string | null;
  from: string;
  to: string;
}

export type LoadedReview =
  | {
      ok: true;
      trades: TradeRow[];
      baseline: TradeRow[];
      truncated: boolean;
      currency: string | null;
      timeZone: string;
      ruleTexts: Map<string, string>;
      /** history and claim scope: the account id, or `ALL-<currency>` */
      scope: string;
    }
  | { ok: false; status: 404 | 422; code: string; message: string; details?: Record<string, unknown> };

/**
 * The period's trades and the BASELINE_DAYS days before it, in one currency. Two loads, so the 5,000-trade cap of a long
 * period never drops the period's newest trades in favour of baseline ones. Unassigned trades (no account) count only
 * when the user's accounts are all in the one currency.
 */
export async function loadReviewInput(deps: LoadDeps, userId: string, s: ReviewScope): Promise<LoadedReview> {
  const [accounts, zone, ruleTexts] = await Promise.all([deps.accounts(userId), deps.timeZone(userId), deps.trades.loadRuleTexts(userId)]);
  const timeZone = resolveTimeZone(zone);
  const one = s.accountId && s.accountId !== 'ALL' ? accounts.find((a) => a.accountId === s.accountId) : null;
  if (s.accountId && s.accountId !== 'ALL' && !one) return { ok: false, status: 404, code: 'NOT_FOUND', message: "We couldn't find that account." };
  const wantCurrency = one ? one.currency : s.currency ? s.currency.toUpperCase() : null;
  if (!one && wantCurrency && !accounts.some((a) => a.currency === wantCurrency)) return { ok: false, status: 404, code: 'NOT_FOUND', message: `You have no account in ${wantCurrency}.` };

  const currencyOf = new Map(accounts.map((a) => [a.accountId, a.currency]));
  const allCurrencies = new Set(accounts.map((a) => a.currency));
  const inCurrency = (cur: string) => (t: TradeRow) => (t.accountId ? currencyOf.get(t.accountId) === cur : allCurrencies.size <= 1);
  const filter = !one && wantCurrency ? inCurrency(wantCurrency) : undefined;
  const range = (from: string, to: string) => ({ from, to, timeZone, accountId: one ? one.accountId : null, ...(filter ? { filter } : {}) });
  const [period, before] = await Promise.all([
    deps.trades.loadTrades(userId, range(s.from, s.to)),
    deps.trades.loadTrades(userId, range(addDays(s.from, -BASELINE_DAYS), addDays(s.from, -1))),
  ]);

  let currency = wantCurrency;
  let trades = period.trades;
  let baseline = before.trades;
  if (!one && !wantCurrency) {
    const used = [...new Set(trades.map((t) => (t.accountId ? currencyOf.get(t.accountId) : undefined)).filter((c): c is string => !!c))].sort();
    if (used.length > 1) {
      return { ok: false, status: 422, code: 'MIXED_CURRENCY', message: `These trades are in ${used.join(' and ')}. Choose one account, or one currency, so amounts are not added across currencies.`, details: { currencies: used } };
    }
    currency = used[0] ?? (allCurrencies.size === 1 ? [...allCurrencies][0] : null);
    if (currency) {
      const keep = inCurrency(currency);
      trades = trades.filter((t) => !t.accountId || keep(t) || !currencyOf.has(t.accountId));
      baseline = baseline.filter((t) => !t.accountId || keep(t) || !currencyOf.has(t.accountId));
    }
  }
  return { ok: true, trades, baseline, truncated: period.truncated, currency, timeZone, ruleTexts, scope: one ? one.accountId : `ALL-${currency ?? 'NONE'}` };
}

/** Trades per currency of the user's accounts in the range (unassigned trades count when there is one currency), for the weekly job. */
export async function tradesPerCurrency(deps: LoadDeps, userId: string, from: string, to: string, timeZone: string): Promise<Map<string, number>> {
  const accounts = await deps.accounts(userId);
  const currencyOf = new Map(accounts.map((a) => [a.accountId, a.currency]));
  const currencies = new Set(accounts.map((a) => a.currency));
  const only = currencies.size === 1 ? [...currencies][0] : null;
  const { trades } = await deps.trades.loadTrades(userId, { from, to, timeZone, accountId: null });
  const out = new Map<string, number>();
  for (const t of trades) {
    const cur = t.accountId ? currencyOf.get(t.accountId) : only;
    if (cur) out.set(cur, (out.get(cur) ?? 0) + 1);
  }
  return out;
}

/** A live trade by id; null when it does not exist or was deleted. */
export async function dynamoTradeById(userId: string, tradeId: string): Promise<TradeRow | null> {
  const found = await loadFullRecords(userId, [{ tradeId }]);
  const it = found.get(tradeId);
  return it && !it.deletedAt ? toTradeRow(it) : null;
}
