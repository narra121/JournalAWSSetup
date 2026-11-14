import { Hono } from 'hono';
import type { AppEnv } from '../../app/types';
import { dynamoAccounts, userTimeZone } from '../analysis/load';
import { generate } from '../ai/gemini';
import { focusApp } from '../focus/routes';
import { getFocus } from '../focus/store';
import { fail, ok, quotaFail, readJson } from '../http';
import { dynamoAiStore } from '../store';
import { dynamoTradeSource } from '../trades-repo';
import { debriefTrade } from './debrief';
import { dynamoTradeById } from './load';
import { generateInsight, type InsightDeps } from './service';
import { getSettings, putSettings, recordFeedback } from './settings';
import { getInsight, listInsights, reviewKeys, setFeedback } from './store';

export const defaultInsightDeps: InsightDeps = {
  store: dynamoAiStore, trades: dynamoTradeSource, accounts: dynamoAccounts, timeZone: userTimeZone, tradeById: dynamoTradeById, generate, now: () => new Date(),
};

const TRADE_ID = /^[A-Za-z0-9_-]{1,100}$/;

export function insightsApp(deps: InsightDeps = defaultInsightDeps): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.post('/generate', async (c) => {
    const body = await readJson(c);
    if (!body) return fail(c, 400, 'VALIDATION_ERROR', 'Request body must be a JSON object.');
    if (body.accountId != null && (typeof body.accountId !== 'string' || body.accountId.length > 100)) return fail(c, 400, 'VALIDATION_ERROR', 'accountId must be a string.');
    if (body.currency != null && typeof body.currency !== 'string') return fail(c, 400, 'VALIDATION_ERROR', 'currency must be a currency code.');
    const r = await generateInsight(deps, c.get('quota'), c.get('userId'), { accountId: body.accountId as string | undefined, currency: body.currency as string | undefined, from: body.from as string, to: body.to as string }, c.get('requestId'));
    if (r.ok) return ok(c, { insight: r.insight });
    if (r.quota) return quotaFail(c, 'ai_insight', r.quota);
    return fail(c, r.status, r.code, r.message, r.details);
  });

  // Fixed paths before `/:id`.
  app.route('/focus', focusApp(deps));

  app.get('/settings', async (c) => ok(c, { settings: await getSettings(deps.store, c.get('userId')) }));
  app.put('/settings', async (c) => {
    const body = await readJson(c);
    if (!body || typeof body.useNotes !== 'boolean') return fail(c, 400, 'VALIDATION_ERROR', 'Send {useNotes: true|false}.');
    const settings = { useNotes: body.useNotes };
    await putSettings(deps.store, c.get('userId'), settings, deps.now());
    return ok(c, { settings });
  });

  app.get('/debrief/:tradeId', async (c) => {
    const tradeId = c.req.param('tradeId');
    if (!TRADE_ID.test(tradeId)) return fail(c, 404, 'NOT_FOUND', 'Trade not found.');
    const userId = c.get('userId');
    const debrief = await debriefTrade(deps, userId, tradeId, await getFocus(deps.store, userId));
    return debrief ? ok(c, { debrief }) : fail(c, 404, 'NOT_FOUND', 'Trade not found.');
  });

  app.get('/', async (c) => {
    const limit = Math.min(50, Math.max(1, Number.parseInt(c.req.query('limit') ?? '20', 10) || 20));
    const r = await listInsights(deps.store, c.get('userId'), { accountId: c.req.query('accountId'), limit, cursor: c.req.query('cursor') });
    return r === 'invalid' ? fail(c, 400, 'VALIDATION_ERROR', 'Invalid cursor.') : ok(c, r);
  });

  app.get('/:id', async (c) => {
    const insight = await getInsight(deps.store, c.get('userId'), c.req.param('id'));
    return insight ? ok(c, { insight }) : fail(c, 404, 'NOT_FOUND', 'Insight not found.');
  });

  app.post('/:id/feedback', async (c) => {
    const body = await readJson(c);
    if (!body || typeof body.key !== 'string' || typeof body.useful !== 'boolean') return fail(c, 400, 'VALIDATION_ERROR', 'Send {key, useful: true|false}.');
    const userId = c.get('userId');
    const insight = await getInsight(deps.store, userId, c.req.param('id'));
    if (!insight) return fail(c, 404, 'NOT_FOUND', 'Insight not found.');
    if (!insight.review || !reviewKeys(insight.review).includes(body.key)) return fail(c, 400, 'VALIDATION_ERROR', 'key is not a finding of this insight.');
    await setFeedback(deps.store, userId, insight.id, body.key, body.useful);
    const { mutedUntil } = await recordFeedback(deps.store, userId, insight.id, body.key, body.useful, deps.now());
    return ok(c, { key: body.key, useful: body.useful, mutedUntil });
  });

  return app;
}
