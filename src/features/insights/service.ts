import type { Quota } from '../../app/types';
import { resolveTimeZone } from '../analysis/load';
import { AiUnavailableError, generate as geminiGenerate } from '../ai/gemini';
import { logAiFailure } from '../ai/log';
import { getFocus } from '../focus/store';
import { timeId } from '../ids';
import type { AiStore } from '../store';
import { dayOf } from '../../shared/timezone';
import type { DebriefDeps } from './debrief';
import { addDays, isoWeekStart, loadHistory, writeHistory } from './history';
import { loadReviewInput, tradesPerCurrency } from './load';
import { MIN_TRADES } from './metrics';
import { buildInsightRequest, reviewPayload } from './prompt';
import { computeInsightInputs } from './review';
import { getSettings, mutedKeys } from './settings';
import { findCached, putInsight, type Insight } from './store';
import { allowedNumbers, validateInsight } from './validate';

export interface InsightDeps extends DebriefDeps {
  store: AiStore;
  generate: typeof geminiGenerate;
  now: () => Date;
}

export interface InsightInput {
  accountId?: string | null;
  /** with every account: the currency to report on (required when the accounts span currencies) */
  currency?: string | null;
  from: string;
  to: string;
}

export type InsightResult =
  | { ok: true; insight: Insight; cached: boolean }
  | { ok: false; status: 400 | 402 | 404 | 409 | 422 | 502; code: string; message: string; details?: Record<string, unknown>; quota?: { limit: number; resetsAt: string } };

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_SPAN_DAYS = 366;
/** A claim is released when the generation ends; this is only how long a crashed one blocks the same inputs. */
const CLAIM_MS = 120_000;
const CLAIM_PREFIX = 'INSIGHT-CLAIM#';

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
  if (input.currency != null && (typeof input.currency !== 'string' || !/^[A-Za-z]{3,10}$/.test(input.currency))) return { ok: false, status: 400, code: 'VALIDATION_ERROR', message: 'currency must be a currency code.' };
  const accountId = input.accountId && input.accountId !== 'ALL' ? input.accountId : null;

  const now = deps.now();
  const [loaded, settings, focus, muted] = await Promise.all([
    loadReviewInput(deps, userId, { accountId, currency: input.currency, from: input.from, to: input.to }),
    getSettings(deps.store, userId),
    getFocus(deps.store, userId),
    mutedKeys(deps.store, userId, now),
  ]);
  if (!loaded.ok) return loaded;
  const weekStart = isoWeekStart(input.to);
  const history = await loadHistory(deps.store, userId, loaded.scope, weekStart);
  const computed = computeInsightInputs({
    period: { from: input.from, to: input.to }, timeZone: loaded.timeZone, currency: loaded.currency, trades: loaded.trades, baseline: loaded.baseline,
    ruleTexts: loaded.ruleTexts, focus, muted, history, useNotes: settings.useNotes,
  });
  const tradeCount = computed.tradeIds.size;
  if (tradeCount < MIN_TRADES) {
    return { ok: false, status: 422, code: 'NOT_ENOUGH_TRADES', message: `At least ${MIN_TRADES} closed trades are needed for an insight; this period has ${tradeCount}.` };
  }

  const cacheKey = { accountId, currency: loaded.currency, from: input.from, to: input.to, metricsHash: computed.hash };
  const cached = await findCached(deps.store, userId, cacheKey);
  if (cached) return { ok: true, insight: cached, cached: true };

  // One generation per user and inputs at a time: a double click must not use two units for the same insight.
  const claimSk = `${CLAIM_PREFIX}${accountId ?? 'ALL'}#${input.from}#${input.to}#${computed.hash}`;
  const claimed = await deps.store.putIfFree({ userId, sk: claimSk, entity: 'insight-claim', expiresAt: now.getTime() + CLAIM_MS }, now.getTime());
  if (!claimed) return { ok: false, status: 409, code: 'IN_PROGRESS', message: 'This insight is already being generated. Try again in a moment.' };
  const release = () => deps.store.delete(userId, [claimSk]).catch(() => undefined);
  // The request that held the claim before us may have finished (and stored its insight) since the lookup above.
  const justMade = await findCached(deps.store, userId, cacheKey);
  if (justMade) {
    await release();
    return { ok: true, insight: justMade, cached: true };
  }

  const q = await quota.consume('ai_insight');
  if (!q.ok) {
    await release();
    return { ok: false, status: 402, code: 'QUOTA_EXCEEDED', message: 'Monthly limit reached for ai_insight.', quota: { limit: q.limit, resetsAt: q.resetsAt } };
  }

  let insight: Insight;
  try {
    const prompt = { period: { from: input.from, to: input.to }, tradeCount };
    const res = await deps.generate(buildInsightRequest(computed, prompt));
    let parsed: unknown;
    try {
      parsed = JSON.parse(res.text);
    } catch {
      parsed = null;
    }
    const body = validateInsight(parsed, computed, allowedNumbers(reviewPayload(computed, prompt)));
    const made = deps.now();
    insight = {
      id: timeId(made), createdAt: made.toISOString(), period: { from: input.from, to: input.to }, accountId,
      summary: body.summary, sections: body.sections, review: body.review, currency: loaded.currency, timeZone: loaded.timeZone,
      model: res.model, tradeCount, ...(loaded.truncated ? { truncated: true } : {}),
    };
    await putInsight(deps.store, userId, insight, computed.hash);
  } catch (e) {
    await release();
    await quota.consume('ai_insight', -1).catch(() => undefined);
    if (e instanceof AiUnavailableError) {
      logAiFailure('insights', e, { requestId, userId });
      return { ok: false, status: 502, code: 'AI_UNAVAILABLE', message: 'The AI service is unavailable right now. You were not charged; try again shortly.' };
    }
    throw e;
  }
  await release();
  // Findings history is kept for whole weeks only, so a month's report never stands in for one week.
  if (addDays(input.from, 6) === input.to) {
    await writeHistory(deps.store, userId, loaded.scope, weekStart, computed.historyRows, insight.id).catch((e) =>
      console.error(JSON.stringify({ level: 'ERROR', msg: 'insight_history_write_failed', userId, error: String(e?.message ?? e).slice(0, 200) })),
    );
  }
  return { ok: true, insight, cached: false };
}

/** The weekly job's period (the 7 days before today in the user's zone) and the currencies with enough trades in it. */
export async function weeklyPlan(deps: InsightDeps, userId: string, now: Date): Promise<{ from: string; to: string; currencies: string[] }> {
  const timeZone = resolveTimeZone(await deps.timeZone(userId));
  const to = addDays(dayOf(now.toISOString(), timeZone), -1);
  const from = addDays(to, -6);
  const counts = await tradesPerCurrency(deps, userId, from, to, timeZone);
  return { from, to, currencies: [...counts].filter(([, n]) => n >= MIN_TRADES).map(([c]) => c).sort() };
}
