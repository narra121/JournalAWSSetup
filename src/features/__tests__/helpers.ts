import { Hono } from 'hono';
import type { AppEnv, Quota, QuotaFeature } from '../../app/types';
import type { AiItem, AiStore } from '../store';
import type { TradeRow, TradeSource } from '../trades-repo';

export function memoryStore(): AiStore & { items: Map<string, AiItem> } {
  const items = new Map<string, AiItem>();
  const id = (u: string, sk: string) => `${u}\u0000${sk}`;
  return {
    items,
    async put(item) {
      items.set(id(item.userId, item.sk), structuredClone(item));
    },
    async get(u, sk) {
      const v = items.get(id(u, sk));
      return v ? structuredClone(v) : null;
    },
    async query(u, o) {
      let rows = [...items.values()].filter((i) => i.userId === u && i.sk.startsWith(o.prefix)).sort((a, b) => (a.sk < b.sk ? -1 : 1));
      if (o.newestFirst) rows.reverse();
      if (o.startKey) {
        const at = rows.findIndex((r) => r.sk === o.startKey!.sk);
        rows = rows.slice(at + 1);
      }
      const page = rows.slice(0, o.limit);
      const more = rows.length > page.length;
      return { items: structuredClone(page), lastKey: more ? { userId: u, sk: page[page.length - 1].sk } : undefined };
    },
    async delete(u, sks) {
      for (const sk of sks) items.delete(id(u, sk));
    },
    async putIfFree(item, nowMs) {
      const held = items.get(id(item.userId, item.sk));
      if (held && !(typeof held.expiresAt === 'number' && held.expiresAt < nowMs)) return false;
      items.set(id(item.userId, item.sk), structuredClone(item));
      return true;
    },
    async patch(u, sk, set) {
      const it = items.get(id(u, sk));
      if (it) Object.assign(it, structuredClone(set));
    },
    async addToCount(u, sk, attr, by, below) {
      const it = items.get(id(u, sk));
      if (!it) return false;
      const cur = typeof it[attr] === 'number' ? (it[attr] as number) : 0;
      if (below !== undefined && it[attr] !== undefined && cur >= below) return false;
      it[attr] = cur + by;
      return true;
    },
  };
}

export function fakeQuota(limits: Partial<Record<QuotaFeature, number>> = {}) {
  const used: Record<string, number> = {};
  const calls: [QuotaFeature, number][] = [];
  const quota: Quota = {
    async consume(f, n = 1) {
      calls.push([f, n]);
      const limit = limits[f];
      if (n > 0 && limit != null && (used[f] ?? 0) + n > limit) return { ok: false, limit, resetsAt: '2026-12-01T00:00:00.000Z' };
      used[f] = Math.max(0, (used[f] ?? 0) + n);
      return { ok: true, remaining: limit == null ? null : limit - used[f] };
    },
  };
  return { quota, used, calls };
}

export function tradeSource(trades: TradeRow[], imported: string[] = [], truncated = false): TradeSource {
  return {
    async loadTrades(_u, r) {
      return { trades: trades.filter((t) => (!r.accountId || t.accountId === r.accountId) && t.openDate >= r.from && t.openDate <= `${r.to}T23:59:59.999Z` && (!r.filter || r.filter(t))), truncated };
    },
    async loadRuleTexts() {
      return new Map([['r1', 'No trades after 2 consecutive losses']]);
    },
    async importedKeys() {
      return new Set(imported);
    },
  };
}

let n = 0;
export function trade(p: Partial<TradeRow> & { pnl: number; openDate: string }): TradeRow {
  n++;
  return {
    id: `t${n}`, accountId: 'acc1', symbol: 'NIFTY', side: 'BUY', quantity: 10, entryPrice: 100, exitPrice: 100, stopLoss: 95, fees: 0, contractMultiplier: null,
    closeDate: new Date(Date.parse(p.openDate) + 30 * 60_000).toISOString(), setupType: 'Breakout', tradingSession: 'Morning', assetClass: 'options', mistakes: [], brokenRuleIds: [], tags: [],
    takeProfit: null, riskRewardRatio: null, marketCondition: null, newsEvents: [], outcome: null, notes: null, lessons: [], optionType: null, expiry: null, reviewed: false, ...p,
  };
}

/** App wrapper that injects the auth context the real middleware would set. */
export function withUser(sub: Hono<AppEnv>, userId: string, quota: Quota) {
  const app = new Hono<AppEnv>();
  app.use('*', async (c, next) => {
    c.set('userId', userId);
    c.set('quota', quota);
    await next();
  });
  app.route('/', sub);
  return app;
}

export const post = async (app: Hono<AppEnv>, path: string, body: unknown): Promise<Response> =>
  app.request(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
