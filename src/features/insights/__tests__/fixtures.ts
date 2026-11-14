import { vi } from 'vitest';
import type { AccountInfo } from '../../analysis/load';
import { row } from '../../analysis/__tests__/build';
import { memoryStore, tradeSource } from '../../__tests__/helpers';
import type { TradeRow } from '../../trades-repo';
import { computeInsightInputs, type ReviewInput } from '../review';
import type { InsightDeps } from '../service';

export const INR: AccountInfo = { accountId: 'acc1', currency: 'INR', initialBalance: null };
export const USD: AccountInfo = { accountId: 'acc2', currency: 'USD', initialBalance: null };

/** A UTC trade at `day` `hhmm`, held `minutes`, with P&L from the prices (entry 100, stop 95 unless given). */
export function tr(id: string, day: string, hhmm: string, p: Partial<TradeRow> = {}, minutes = 20): TradeRow {
  const openDate = `${day}T${hhmm}:00.000Z`;
  return row({ id, openDate, closeDate: new Date(Date.parse(openDate) + minutes * 60_000).toISOString(), ...p });
}

/** A trade of `r` R (risk 5 × quantity 10 = 50 a trade), so P&L = 50 × r. */
export const rTrade = (id: string, day: string, hhmm: string, r: number, p: Partial<TradeRow> = {}) =>
  tr(id, day, hhmm, { entryPrice: 100, stopLoss: 95, exitPrice: 100 + 5 * r, quantity: 10, ...p });

export function reviewOf(trades: TradeRow[], over: Partial<ReviewInput> = {}) {
  return computeInsightInputs({
    period: { from: '2026-10-05', to: '2026-10-11' }, timeZone: 'UTC', currency: 'INR', trades, baseline: [],
    ruleTexts: new Map(), focus: null, muted: new Set(), history: [], useNotes: false, ...over,
  });
}

export const modelReply = (body: unknown, model = 'gemini-test') => ({ text: JSON.stringify(body), model, usage: { promptTokens: 1, outputTokens: 1 } });

export function insightDeps(trades: TradeRow[], over: Partial<InsightDeps> = {}, accounts: AccountInfo[] = [INR]) {
  const store = memoryStore();
  const generate = vi.fn(async () => modelReply({ summary: 'A short week.', verdict: 'A losing week.' }));
  const deps: InsightDeps = {
    store, trades: tradeSource(trades), accounts: async () => accounts, timeZone: async () => null,
    tradeById: async (_u, id) => trades.find((t) => t.id === id) ?? null, generate, now: () => new Date('2026-11-11T10:00:00Z'), ...over,
  };
  return { deps, store, generate: deps.generate as typeof generate };
}
