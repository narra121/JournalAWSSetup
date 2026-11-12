import type { Quota } from '../../app/types';
import { AiUnavailableError, generate as geminiGenerate } from '../ai/gemini';
import { logAiFailure } from '../ai/log';
import { timeId } from '../ids';
import type { AiStore } from '../store';
import type { TradeSource } from '../trades-repo';
import { computeInsightInputs, MIN_TRADES } from './metrics';
import { buildInsightRequest } from './prompt';
import { findCached, putInsight, type Insight } from './store';
import { validateInsight } from './validate';

export interface InsightDeps {
  store: AiStore;
  trades: TradeSource;
  generate: typeof geminiGenerate;
  now: () => Date;
}

export interface InsightInput {
  accountId?: string | null;
  from: string;
  to: string;
}

export type InsightResult =
  | { ok: true; insight: Insight; cached: boolean }
  | { ok: false; status: 400 | 402 | 422 | 502; code: string; message: string; quota?: { limit: number; resetsAt: string } };

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_SPAN_DAYS = 366;

export function validatePeriod(from: unknown, to: unknown): string | null {
  if (typeof from !== 'string' || typeof to !== 'string' || !DATE.test(from) || !DATE.test(to)) return 'from and to must be dates (YYYY-MM-DD).';
  const a = Date.parse(`${from}T00:00:00Z`);
  const b = Date.parse(`${to}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b) || new Date(a).toISOString().slice(0, 10) !== from || new Date(b).toISOString().slice(0, 10) !== to) return 'from and to must be real dates.';
  if (a > b) return 'from must not be after to.';
  if ((b - a) / 86_400_000 > MAX_SPAN_DAYS) return `The period can be at most ${MAX_SPAN_DAYS} days.`;
  return null;
}

/** Shared by POST /insights/generate and the weekly scheduler (Event Function). */
export async function generateInsight(deps: InsightDeps, quota: Quota, userId: string, input: InsightInput, requestId?: string): Promise<InsightResult> {
  const bad = validatePeriod(input.from, input.to);
  if (bad) return { ok: false, status: 400, code: 'VALIDATION_ERROR', message: bad };
  const accountId = input.accountId && input.accountId !== 'ALL' ? input.accountId : null;

  const [loaded, rules] = await Promise.all([deps.trades.loadTrades(userId, { from: input.from, to: input.to, accountId }), deps.trades.loadRuleTexts(userId)]);
  const computed = computeInsightInputs(loaded.trades, rules);
  const tradeCount = computed.tradeIds.size;
  if (tradeCount < MIN_TRADES) {
    return { ok: false, status: 422, code: 'NOT_ENOUGH_TRADES', message: `At least ${MIN_TRADES} closed trades are needed for an insight; this period has ${tradeCount}.` };
  }

  const cached = await findCached(deps.store, userId, { accountId, from: input.from, to: input.to, metricsHash: computed.hash });
  if (cached) return { ok: true, insight: cached, cached: true };

  const q = await quota.consume('ai_insight');
  if (!q.ok) return { ok: false, status: 402, code: 'QUOTA_EXCEEDED', message: 'Monthly limit reached for ai_insight.', quota: { limit: q.limit, resetsAt: q.resetsAt } };

  try {
    const res = await deps.generate(buildInsightRequest(computed, { period: { from: input.from, to: input.to }, tradeCount }));
    let parsed: unknown;
    try {
      parsed = JSON.parse(res.text);
    } catch {
      parsed = null;
    }
    const body = validateInsight(parsed, computed);
    const now = deps.now();
    const insight: Insight = { id: timeId(now), createdAt: now.toISOString(), period: { from: input.from, to: input.to }, accountId, summary: body.summary, sections: body.sections, model: res.model, tradeCount, ...(loaded.truncated ? { truncated: true } : {}) };
    await putInsight(deps.store, userId, insight, computed.hash);
    return { ok: true, insight, cached: false };
  } catch (e) {
    await quota.consume('ai_insight', -1).catch(() => undefined);
    if (e instanceof AiUnavailableError) {
      logAiFailure('insights', e, { requestId, userId });
      return { ok: false, status: 502, code: 'AI_UNAVAILABLE', message: 'The AI service is unavailable right now. You were not charged; try again shortly.' };
    }
    throw e;
  }
}
