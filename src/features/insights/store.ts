import { decodeCursor, encodeCursor, type AiItem, type AiStore } from '../store';
import type { InsightSection } from './validate';

export interface Insight {
  id: string;
  createdAt: string;
  period: { from: string; to: string };
  accountId: string | null;
  summary: string;
  sections: InsightSection[];
  model: string;
  tradeCount: number;
  /** present (true) when the period held more trades than could be loaded: the insight covers the oldest ones only */
  truncated?: boolean;
}

export const INSIGHT_ID = /^\d{8}T\d{9}Z_[0-9a-f]{8}$/;
const PREFIX = 'INSIGHT#';

interface Stored extends Insight {
  metricsHash: string;
}

const toInsight = (it: AiItem): Insight => {
  const { userId: _u, sk: _s, entity: _e, metricsHash: _h, metricsVersion: _v, ...rest } = it;
  return rest as unknown as Insight;
};

export async function putInsight(store: AiStore, userId: string, insight: Insight, metricsHash: string) {
  const item: Stored & AiItem = { userId, sk: `${PREFIX}${insight.id}`, entity: 'insight', metricsVersion: 1, metricsHash, ...insight };
  await store.put(item);
}

export async function getInsight(store: AiStore, userId: string, id: string): Promise<Insight | null> {
  const it = INSIGHT_ID.test(id) ? await store.get(userId, `${PREFIX}${id}`) : null;
  return it ? toInsight(it) : null;
}

export async function listInsights(store: AiStore, userId: string, o: { accountId?: string | null; limit: number; cursor?: string }) {
  const start = decodeCursor(userId, o.cursor);
  if (start === 'invalid') return 'invalid' as const;
  const r = await store.query(userId, { prefix: PREFIX, limit: o.limit, newestFirst: true, startKey: start });
  const items = o.accountId ? r.items.filter((i) => i.accountId === o.accountId) : r.items;
  return { insights: items.map(toInsight), nextCursor: encodeCursor(userId, r.lastKey) };
}

/** Latest stored insight with the same inputs and the same metrics: regenerating would only repeat it. */
export async function findCached(store: AiStore, userId: string, q: { accountId: string | null; from: string; to: string; metricsHash: string }): Promise<Insight | null> {
  const r = await store.query(userId, { prefix: PREFIX, limit: 20, newestFirst: true });
  const hit = r.items.find((i) => i.metricsHash === q.metricsHash && (i.accountId ?? null) === q.accountId && (i.period as Insight['period']).from === q.from && (i.period as Insight['period']).to === q.to);
  return hit ? toInsight(hit) : null;
}
