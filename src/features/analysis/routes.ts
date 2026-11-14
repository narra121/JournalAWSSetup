import { Hono, type Context } from 'hono';
import type { AppEnv } from '../../app/types';
import { fail, ok, readJson } from '../http';
import { buildAnalysis } from './analysis';
import { tradeFacts } from './facts';
import { loadAnalysisInput, type AnalysisDeps, type AnalysisScope } from './load';
import { parseAnalysisQuery, runQuery } from './query';
import { parseWhatIfRule, replay } from './whatif';

const accountOf = (v: unknown): string | null | undefined =>
  v == null || v === '' ? null : typeof v === 'string' && v.length <= 100 ? v : undefined;

/** `GET /analysis`, `POST /analysis/what-if`, `POST /analysis/query` (CONTRACT I4): load, then call the pure functions. */
export function analysisApp(deps: AnalysisDeps): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  const load = async (c: Context<AppEnv>, scope: AnalysisScope, ruleTexts = false) => {
    const input = await loadAnalysisInput(deps, c.get('userId'), scope, { ruleTexts });
    return input.ok ? input : fail(c, input.status, input.code, input.message, input.details);
  };

  app.get('/', async (c) => {
    const accountId = accountOf(c.req.query('accountId'));
    if (accountId === undefined) return fail(c, 400, 'VALIDATION_ERROR', 'accountId is too long.');
    const limitText = c.req.query('dailyLossLimit');
    const dailyLossLimit = limitText ? Number(limitText) : null;
    if (dailyLossLimit != null && !(Number.isFinite(dailyLossLimit) && dailyLossLimit > 0)) return fail(c, 400, 'VALIDATION_ERROR', 'dailyLossLimit must be a positive amount.');
    const from = c.req.query('from') ?? '';
    const to = c.req.query('to') ?? '';
    const input = await load(c, { accountId, from, to }, true);
    if (input instanceof Response) return input;
    const analysis = buildAnalysis(input.trades, {
      period: { from, to }, timeZone: input.timeZone, currency: input.currency, truncated: input.truncated,
      startingBalance: input.startingBalance, dailyLossLimit, ruleTexts: input.ruleTexts,
    });
    return ok(c, { analysis });
  });

  app.post('/what-if', async (c) => {
    const body = await readJson(c);
    const accountId = accountOf(body?.accountId);
    if (!body || accountId === undefined) return fail(c, 400, 'VALIDATION_ERROR', 'Send {accountId, from, to, rule}.');
    const rule = parseWhatIfRule(body.rule);
    if (typeof rule === 'string') return fail(c, 400, 'VALIDATION_ERROR', rule);
    const input = await load(c, { accountId, from: String(body.from ?? ''), to: String(body.to ?? '') });
    if (input instanceof Response) return input;
    return ok(c, { result: replay(tradeFacts(input.trades, input.timeZone), rule), truncated: input.truncated });
  });

  app.post('/query', async (c) => {
    const body = await readJson(c);
    const accountId = accountOf(body?.accountId);
    if (!body || accountId === undefined) return fail(c, 400, 'VALIDATION_ERROR', 'Send {accountId, from, to, query}.');
    const query = parseAnalysisQuery(body.query);
    if (typeof query === 'string') return fail(c, 400, 'VALIDATION_ERROR', query);
    // A comparison reads both of its periods, whatever from and to say.
    const scope = query.kind === 'compare'
      ? { accountId, from: query.a.from < query.b.from ? query.a.from : query.b.from, to: query.a.to > query.b.to ? query.a.to : query.b.to }
      : { accountId, from: String(body.from ?? ''), to: String(body.to ?? '') };
    const input = await load(c, scope);
    if (input instanceof Response) return input;
    return ok(c, { result: runQuery(input.trades, query, { timeZone: input.timeZone }), truncated: input.truncated });
  });

  return app;
}
