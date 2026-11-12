import { Hono } from 'hono';
import type { AppEnv } from '../../app/types';
import { generate } from '../ai/gemini';
import { fail, ok, quotaFail, readJson } from '../http';
import { dynamoAiStore } from '../store';
import { dynamoTradeSource } from '../trades-repo';
import { generateInsight, type InsightDeps } from './service';
import { getInsight, listInsights } from './store';

export const defaultInsightDeps: InsightDeps = { store: dynamoAiStore, trades: dynamoTradeSource, generate, now: () => new Date() };

export function insightsApp(deps: InsightDeps = defaultInsightDeps): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.post('/generate', async (c) => {
    const body = await readJson(c);
    if (!body) return fail(c, 400, 'VALIDATION_ERROR', 'Request body must be a JSON object.');
    if (body.accountId != null && (typeof body.accountId !== 'string' || body.accountId.length > 100)) return fail(c, 400, 'VALIDATION_ERROR', 'accountId must be a string.');
    const r = await generateInsight(deps, c.get('quota'), c.get('userId'), { accountId: body.accountId as string | undefined, from: body.from as string, to: body.to as string }, c.get('requestId'));
    if (r.ok) return ok(c, { insight: r.insight });
    if (r.quota) return quotaFail(c, 'ai_insight', r.quota);
    return fail(c, r.status, r.code, r.message);
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

  return app;
}
