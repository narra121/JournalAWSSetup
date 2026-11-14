import { describe, expect, it, vi } from 'vitest';
import { AiUnavailableError } from '../../ai/gemini';
import { fakeQuota, post, trade, tradeSource, withUser } from '../../__tests__/helpers';
import type { TradeRow } from '../../trades-repo';
import { computeChatMetrics } from '../metrics';
import { insightsApp } from '../routes';
import { generateInsight, weeklyPlan } from '../service';
import { listInsights, putInsight, type Insight } from '../store';
import { INR, insightDeps, modelReply, rTrade, USD } from './fixtures';

const at = (day: string, hhmm: string) => `${day}T${hhmm}:00.000Z`;

/** Breakout: 10 trades, 6 × +100 and 4 × -50 (net 400). Reversal: 8 × -100 back to back on one day, no stop (net -800). */
function dataset(): TradeRow[] {
  const rows: TradeRow[] = [];
  const pnls = [100, 100, -50, 100, 100, -50, 100, -50, 100, -50];
  pnls.forEach((p, i) => rows.push(trade({ id: `b${i}`, pnl: p, openDate: at(`2026-10-0${(i % 4) + 5}`, `0${4 + (i % 3)}:00`), setupType: 'Breakout' })));
  for (let i = 0; i < 8; i++) {
    const open = Date.parse(at('2026-10-12', '04:00')) + i * 40 * 60_000;
    rows.push(trade({ id: `r${i}`, pnl: -100, openDate: new Date(open).toISOString(), setupType: 'Reversal', stopLoss: null, mistakes: ['Revenge'] }));
  }
  return rows;
}

describe('base metrics (chat and report payload)', () => {
  const c = computeChatMetrics(dataset());

  it('computes totals from the data, not from a model', () => {
    expect(c.metrics.trades.value).toBe(18);
    expect(c.metrics.netPnl.value).toBe(-400);
    expect(c.metrics.winRate.value).toBeCloseTo(33.33, 1);
    expect(c.metrics.avgWin.value).toBeCloseTo(100);
    expect(c.metrics.profitFactor.value).toBeCloseTo(600 / 1000, 5);
    expect(c.metrics.maxLossStreak.value).toBe(9); // the last Breakout trade (10-08) also lost
    expect(c.metrics.netPnl.display).toBe('-400.00');
  });

  it('average R is realised R from prices (CONTRACT I2), not P&L ÷ (risk × quantity)', () => {
    const t = [
      trade({ id: 'x1', pnl: 999, openDate: at('2026-10-05', '04:00'), entryPrice: 100, stopLoss: 95, exitPrice: 110, quantity: 3, contractMultiplier: 50 }),
      trade({ id: 'x2', pnl: -1, openDate: at('2026-10-06', '04:00'), side: 'SELL', entryPrice: 100, stopLoss: 105, exitPrice: 105 }),
      trade({ id: 'x3', pnl: 5, openDate: at('2026-10-07', '04:00'), stopLoss: null }),
    ];
    expect(computeChatMetrics(t).metrics.avgR.value).toBeCloseTo((2 - 1) / 2, 10);
  });
});

const review = { summary: 'A losing period; the trades without a stop cost ₹800.00.', verdict: 'A losing period.' };

function setup(over: Parameters<typeof insightDeps>[1] = {}, limits = { ai_insight: 1 }, trades = dataset(), accounts = [INR]) {
  const generate = vi.fn(async () => modelReply(review));
  const d = insightDeps(trades, { generate, ...over }, accounts);
  return { deps: d.deps, store: d.store, generate: d.deps.generate as typeof generate, q: fakeQuota(limits) };
}
const OCT = { from: '2026-10-01', to: '2026-10-31' };

describe('generateInsight', () => {
  it('generates the review, stores it with the old section list, and cites only the user’s own trade ids', async () => {
    const { deps, store, generate, q } = setup();
    const r = await generateInsight(deps, q.quota, 'u1', OCT);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(generate).toHaveBeenCalledTimes(1);
    expect((generate.mock.calls[0] as any)[0].purpose).toBe('report');
    expect(r.insight).toMatchObject({ tradeCount: 18, currency: 'INR', timeZone: 'UTC', summary: review.summary });
    expect(r.insight.review!.theOne).toMatchObject({ key: 'detector:noStop', cost: 800, trades: 8 });
    expect(r.insight.review!.verdict.text).toBe('A losing period.');
    expect(r.insight.sections[0]).toMatchObject({ kind: 'leak', title: 'No stop recorded' });
    const own = new Set(dataset().map((t) => t.id));
    const cited = [...r.insight.sections.flatMap((s) => s.tradeIds ?? []), ...(r.insight.review!.theOne?.tradeIds ?? []), ...r.insight.review!.watch.flatMap((w) => w.tradeIds)];
    expect(cited.every((id) => own.has(id))).toBe(true);
    expect(q.used.ai_insight).toBe(1);
    expect(store.items.size).toBe(1); // a month is not written to the weekly findings history
  });

  it('marks the insight truncated when the period held more trades than could be loaded', async () => {
    const { deps, q } = setup({ trades: tradeSource(dataset(), [], true) });
    const r = await generateInsight(deps, q.quota, 'u1', OCT);
    expect(r.ok && r.insight.truncated).toBe(true);
    const normal = setup();
    const n = await generateInsight(normal.deps, normal.q.quota, 'u1', OCT);
    expect(n.ok && n.insight.truncated).toBeUndefined();
  });

  it('serves a cached insight for the same data without Gemini or quota', async () => {
    const { deps, generate, q } = setup();
    const first = await generateInsight(deps, q.quota, 'u1', OCT);
    const second = await generateInsight(deps, q.quota, 'u1', OCT);
    expect(second.ok && second.cached).toBe(true);
    expect(second.ok && first.ok && second.insight.id === first.insight.id).toBe(true);
    expect(generate).toHaveBeenCalledTimes(1);
    expect(q.calls).toHaveLength(1);
  });

  describe('one generation at a time for the same inputs (BE-109)', () => {
    it('a double click uses one unit and one Gemini call: the second request is a 409, or the finished insight', async () => {
      const { deps, generate, q, store } = setup();
      const results = await Promise.all([generateInsight(deps, q.quota, 'u1', OCT), generateInsight(deps, q.quota, 'u1', OCT)]);
      expect(results.every((r) => r.ok || (r.status === 409 && r.code === 'IN_PROGRESS'))).toBe(true);
      expect(results.filter((r) => r.ok && !r.cached)).toHaveLength(1);
      expect(generate).toHaveBeenCalledTimes(1);
      expect(q.used.ai_insight).toBe(1);
      expect([...store.items.values()].some((i) => i.sk.startsWith('INSIGHT-CLAIM#'))).toBe(false);
    });

    it('the claim is released when the quota is exhausted and when Gemini fails, so a retry can run', async () => {
      const full = setup({}, { ai_insight: 0 });
      expect(await generateInsight(full.deps, full.q.quota, 'u1', OCT)).toMatchObject({ ok: false, status: 402 });
      expect([...full.store.items.values()]).toHaveLength(0);

      const down = setup({ generate: vi.fn().mockRejectedValue(new AiUnavailableError('down', 'm', 503)) });
      expect(await generateInsight(down.deps, down.q.quota, 'u1', OCT)).toMatchObject({ ok: false, status: 502 });
      expect([...down.store.items.values()]).toHaveLength(0);
      expect(down.q.used.ai_insight).toBe(0);
    });

    it('a claim left by a crashed run blocks only until it expires', async () => {
      const { deps, store, q, generate } = setup({}, { ai_insight: 5 });
      const base = await generateInsight(deps, q.quota, 'u1', OCT); // learn the hash through the stored insight
      expect(base.ok).toBe(true);
      const hash = [...store.items.values()].find((i) => i.entity === 'insight')!.metricsHash as string;
      const sk = `INSIGHT-CLAIM#ALL#${OCT.from}#${OCT.to}#${hash}`;
      store.items.clear();
      await store.putIfFree({ userId: 'u1', sk, entity: 'insight-claim', expiresAt: deps.now().getTime() + 60_000 }, deps.now().getTime());
      expect(await generateInsight(deps, q.quota, 'u1', OCT)).toMatchObject({ ok: false, status: 409 });
      store.items.clear();
      await store.putIfFree({ userId: 'u1', sk, entity: 'insight-claim', expiresAt: deps.now().getTime() - 1 }, deps.now().getTime() - 5);
      const later = await generateInsight(deps, q.quota, 'u1', OCT);
      expect(later.ok).toBe(true);
      expect(generate).toHaveBeenCalledTimes(2);
    });
  });

  it('422 below five trades, no quota used', async () => {
    const { deps, q } = setup({ trades: tradeSource(dataset().slice(0, 4)) });
    const r = await generateInsight(deps, q.quota, 'u1', OCT);
    expect(r).toMatchObject({ ok: false, status: 422, code: 'NOT_ENOUGH_TRADES' });
    expect(q.calls).toHaveLength(0);
  });

  it('402 when the quota is exhausted and Gemini is not called', async () => {
    const { deps, generate, q } = setup({}, { ai_insight: 0 });
    const r = await generateInsight(deps, q.quota, 'u1', OCT);
    expect(r).toMatchObject({ ok: false, status: 402, quota: { limit: 0 } });
    expect(generate).not.toHaveBeenCalled();
  });

  it('refunds the unit and returns 502 when Gemini fails', async () => {
    const { deps, q } = setup({ generate: vi.fn(async () => { throw new AiUnavailableError('down'); }) as any });
    const r = await generateInsight(deps, q.quota, 'u1', OCT);
    expect(r).toMatchObject({ ok: false, status: 502, code: 'AI_UNAVAILABLE' });
    expect(q.used.ai_insight).toBe(0);
    expect(q.calls.map((x) => x[1])).toEqual([1, -1]);
  });

  it('refunds the unit when storing fails after the model answered, and rethrows', async () => {
    const { deps, q, store } = setup();
    store.put = async () => { throw new Error('dynamo down'); };
    await expect(generateInsight(deps, q.quota, 'u1', OCT)).rejects.toThrow('dynamo down');
    expect(q.calls.map((x) => x[1])).toEqual([1, -1]);
  });

  it('logs one structured warn line (feature, model, status, message) when Gemini is unavailable', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      const err = new AiUnavailableError('gemini-2.5-flash 429 Quota exceeded for metric', 'gemini-2.5-flash', 429);
      const { deps, q } = setup({ generate: vi.fn(async () => { throw err; }) as any });
      await generateInsight(deps, q.quota, 'u1', OCT, 'req-9');
      const lines = log.mock.calls.map((c) => String(c[0])).filter((l) => l.includes('ai_unavailable'));
      expect(lines).toHaveLength(1);
      expect(JSON.parse(lines[0])).toMatchObject({ level: 'WARN', msg: 'ai_unavailable', feature: 'insights', model: 'gemini-2.5-flash', status: 429, error: 'gemini-2.5-flash 429 Quota exceeded for metric', requestId: 'req-9', userId: 'u1' });
      expect(lines[0]).not.toMatch(/NIFTY|Breakout|Reversal|"pnl"/);
    } finally {
      log.mockRestore();
    }
  });

  it('logs one ai_call info line with the model and tokens of a generated report', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      const { deps, q } = setup({ generate: vi.fn(async () => ({ text: 'not json', model: 'openai/gpt-6.1-terra', usage: { promptTokens: 900, outputTokens: 200 } })) as any });
      await generateInsight(deps, q.quota, 'u1', OCT, 'req-7');
      const lines = log.mock.calls.map((c) => String(c[0])).filter((l) => l.includes('ai_call'));
      expect(lines).toHaveLength(1);
      expect(JSON.parse(lines[0])).toMatchObject({ level: 'INFO', msg: 'ai_call', feature: 'insights', model: 'openai/gpt-6.1-terra', promptTokens: 900, outputTokens: 200, requestId: 'req-7', userId: 'u1' });
    } finally {
      log.mockRestore();
    }
  });

  it('survives non-JSON model output with the code wording', async () => {
    const { deps, q } = setup({ generate: vi.fn(async () => ({ text: 'not json', model: 'm', usage: { promptTokens: 0, outputTokens: 0 } })) as any });
    const r = await generateInsight(deps, q.quota, 'u1', OCT);
    expect(r.ok && r.insight.review!.verdict.text).toBe(r.ok && r.insight.review!.verdict.headline);
    expect(r.ok && r.insight.sections.length).toBeGreaterThanOrEqual(2);
  });

  it.each([
    ['2026-10-31', '2026-10-01'],
    ['2026-02-30', '2026-03-01'],
    ['2025-01-01', '2026-10-01'],
    ['bad', '2026-10-01'],
  ])('rejects the period %s → %s', async (from, to) => {
    const { deps, q } = setup();
    const r = await generateInsight(deps, q.quota, 'u1', { from, to });
    expect(r).toMatchObject({ ok: false, status: 400 });
  });

  describe('one currency per report', () => {
    const mixed = () => [...dataset(), ...[1, -1, 1, 1, -1].map((r, i) => rTrade(`u${i}`, `2026-10-1${i}`, '09:00', r, { accountId: 'acc2' }))];

    it('all accounts across currencies: 422 MIXED_CURRENCY with the currencies, no quota used', async () => {
      const { deps, q } = setup({}, { ai_insight: 1 }, mixed(), [INR, USD]);
      expect(await generateInsight(deps, q.quota, 'u1', OCT)).toMatchObject({ ok: false, status: 422, code: 'MIXED_CURRENCY', details: { currencies: ['INR', 'USD'] } });
      expect(q.calls).toHaveLength(0);
    });

    it('with a currency: only that currency’s accounts, baseline included', async () => {
      const { deps, q } = setup({}, { ai_insight: 2 }, mixed(), [INR, USD]);
      const usd = await generateInsight(deps, q.quota, 'u1', { ...OCT, currency: 'usd' });
      expect(usd.ok && usd.insight).toMatchObject({ currency: 'USD', tradeCount: 5, accountId: null });
      const inr = await generateInsight(deps, q.quota, 'u1', { ...OCT, currency: 'INR' });
      expect(inr.ok && inr.insight.tradeCount).toBe(18);
      expect(await generateInsight(deps, q.quota, 'u1', { ...OCT, currency: 'EUR' })).toMatchObject({ ok: false, status: 404 });
    });

    it('one account: its currency; an unknown account is a 404', async () => {
      const { deps, q } = setup({}, { ai_insight: 2 }, mixed(), [INR, USD]);
      const r = await generateInsight(deps, q.quota, 'u1', { ...OCT, accountId: 'acc2' });
      expect(r.ok && r.insight).toMatchObject({ currency: 'USD', accountId: 'acc2', tradeCount: 5 });
      expect(await generateInsight(deps, q.quota, 'u1', { ...OCT, accountId: 'nope' })).toMatchObject({ ok: false, status: 404 });
    });
  });

  it('a week writes the findings history, and the next week reads it ("second week in a row")', async () => {
    const weekOf = (start: string, prefix: string) => Array.from({ length: 6 }, (_, i) => trade({ id: `${prefix}${i}`, pnl: -100, stopLoss: null, openDate: at(new Date(Date.parse(`${start}T00:00:00Z`) + i * 86_400_000).toISOString().slice(0, 10), '04:00') }));
    const trades = [...weekOf('2026-10-05', 'a'), ...weekOf('2026-10-12', 'b')];
    const { deps, q, store } = setup({}, { ai_insight: 5 }, trades);
    const first = await generateInsight(deps, q.quota, 'u1', { from: '2026-10-05', to: '2026-10-11' });
    expect(first.ok && first.insight.review!.theOne).toMatchObject({ key: 'detector:noStop', history: { weeksInRow: 1, status: 'new' } });
    expect([...store.items.values()].find((i) => i.sk === 'FINDING#ALL-INR#2026-10-05#detector:noStop')).toMatchObject({ week: '2026-W41', count: 6, shown: true });
    const second = await generateInsight(deps, q.quota, 'u1', { from: '2026-10-12', to: '2026-10-18' });
    expect(second.ok && second.insight.review!.theOne).toMatchObject({ history: { weeksInRow: 2, lastWeekCount: 6, status: 'same' } });
    expect(second.ok && second.insight.review!.theOne!.text).toContain('Second week in a row.');
  });

  it('uses the user’s time zone, never a fixed India offset', async () => {
    const { deps, q } = setup({ timeZone: async () => 'America/New_York' });
    const r = await generateInsight(deps, q.quota, 'u1', OCT);
    expect(r.ok && r.insight.timeZone).toBe('America/New_York');
    expect(r.ok && r.insight.review!.timeZone).toBe('America/New_York');
  });
});

describe('weekly plan', () => {
  it('the 7 days before today in the user’s zone, and only currencies with at least 5 trades', async () => {
    const trades = [
      ...[1, -1, 1, 1, -1].map((r, i) => rTrade(`i${i}`, `2026-11-0${4 + i}`, '09:00', r)),
      ...[1, -1, 1, 1].map((r, i) => rTrade(`u${i}`, `2026-11-0${4 + i}`, '09:00', r, { accountId: 'acc2' })),
    ];
    const { deps } = setup({ timeZone: async () => 'Asia/Kolkata' }, { ai_insight: 1 }, trades, [INR, USD]);
    expect(await weeklyPlan(deps, 'u1', new Date('2026-11-10T20:00:00Z'))).toEqual({ from: '2026-11-04', to: '2026-11-10', currencies: ['INR'] });
    const ny = setup({ timeZone: async () => 'America/New_York' }, { ai_insight: 1 }, trades, [INR, USD]);
    expect(await weeklyPlan(ny.deps, 'u1', new Date('2026-11-10T03:00:00Z'))).toMatchObject({ from: '2026-11-02', to: '2026-11-08' });
  });
});

describe('insights routes', () => {
  it('generate → list → get, with per-user isolation and cursor binding', async () => {
    const { deps, q } = setup();
    const app = withUser(insightsApp(deps), 'u1', q.quota);
    const gen = await post(app, '/generate', OCT);
    expect(gen.status).toBe(200);
    const { data } = (await gen.json()) as any;
    expect(data.insight.review.theOne.key).toBe('detector:noStop');

    const list = (await (await app.request('/')).json()) as any;
    expect(list.data.insights.map((i: any) => i.id)).toEqual([data.insight.id]);
    const one = await app.request(`/${data.insight.id}`);
    expect(one.status).toBe(200);
    expect((await app.request('/20260101T000000000Z_deadbeef')).status).toBe(404);
    expect((await app.request('/not-an-id')).status).toBe(404);

    const other = withUser(insightsApp(deps), 'u2', q.quota);
    expect((await other.request(`/${data.insight.id}`)).status).toBe(404);
    expect(((await (await other.request('/')).json()) as any).data.insights).toEqual([]);
    expect((await app.request('/?cursor=garbage')).status).toBe(400);
  });

  it('the fixed paths (focus, settings, debrief) are served before /:id', async () => {
    const { deps, q } = setup();
    const app = withUser(insightsApp(deps), 'u1', q.quota);
    expect(await (await app.request('/focus')).json()).toMatchObject({ data: { focus: null, progress: null } });
    expect((await app.request('/settings')).status).toBe(200);
    expect((await app.request('/debrief/b0')).status).toBe(200);
  });

  it('maps quota exhaustion to the 402 contract shape', async () => {
    const { deps, q } = setup({}, { ai_insight: 0 });
    const res = await post(withUser(insightsApp(deps), 'u1', q.quota), '/generate', OCT);
    expect(res.status).toBe(402);
    expect(await res.json()).toMatchObject({ success: false, errorCode: 'QUOTA_EXCEEDED', error: { code: 'QUOTA_EXCEEDED', feature: 'ai_insight', limit: 0, resetsAt: '2026-12-01T00:00:00.000Z' } });
  });

  it('a mixed-currency request is a 422 that names the currencies', async () => {
    const t = [...dataset(), ...[1, -1, 1, 1, -1].map((r, i) => rTrade(`u${i}`, `2026-10-1${i}`, '09:00', r, { accountId: 'acc2' }))];
    const { deps, q } = setup({}, { ai_insight: 1 }, t, [INR, USD]);
    const res = await post(withUser(insightsApp(deps), 'u1', q.quota), '/generate', OCT);
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({ error: { code: 'MIXED_CURRENCY', currencies: ['INR', 'USD'] } });
  });

  it('an insight stored before the review existed still loads, lists and renders from its sections', async () => {
    const { deps, q, store } = setup();
    const old = { id: '20261001T000000000Z_00000001', createdAt: '2026-10-01T00:00:00.000Z', period: OCT, accountId: null, summary: 'Old', sections: [{ kind: 'leak', title: 'Losses in Reversal', body: 'b' }], model: 'm', tradeCount: 18 } as Insight;
    await putInsight(store, 'u1', old, 'h-old');
    const app = withUser(insightsApp(deps), 'u1', q.quota);
    const got = (await (await app.request(`/${old.id}`)).json()) as any;
    expect(got.data.insight).toEqual(old);
    expect(got.data.insight.review).toBeUndefined();
    const list = (await (await app.request('/')).json()) as any;
    expect(list.data.insights[0].sections[0].title).toBe('Losses in Reversal');
    // old insights carry no review keys, so there is nothing to answer
    expect((await post(app, `/${old.id}/feedback`, { key: 'x', useful: false })).status).toBe(400);
  });

  it('feedback: "not useful" mutes the key for 30 days, the next review leaves it out; "useful" lifts it', async () => {
    const { deps, q, store } = setup({}, { ai_insight: 5 });
    const app = withUser(insightsApp(deps), 'u1', q.quota);
    const first = ((await (await post(app, '/generate', OCT)).json()) as any).data.insight;
    expect(first.review.theOne.key).toBe('detector:noStop');
    const res = await post(app, `/${first.id}/feedback`, { key: 'detector:noStop', useful: false });
    expect(await res.json()).toMatchObject({ data: { key: 'detector:noStop', useful: false, mutedUntil: '2026-12-11T10:00:00.000Z' } });
    expect(((await (await app.request(`/${first.id}`)).json()) as any).data.insight.feedback).toEqual({ 'detector:noStop': false });

    const second = ((await (await post(app, '/generate', OCT)).json()) as any).data.insight;
    expect(second.id).not.toBe(first.id);
    expect(second.review.theOne?.key).not.toBe('detector:noStop');
    expect(second.review.muted).toEqual(['detector:noStop']);

    await post(app, `/${first.id}/feedback`, { key: 'detector:noStop', useful: true });
    expect([...store.items.values()].some((i) => i.sk.startsWith('MUTE#'))).toBe(false);
    expect((await post(app, `/${first.id}/feedback`, { key: 'detector:nope', useful: false })).status).toBe(400);
    expect((await post(app, `/${first.id}/feedback`, { key: 'detector:noStop' })).status).toBe(400);
    expect((await post(app, '/20260101T000000000Z_deadbeef/feedback', { key: 'detector:noStop', useful: false })).status).toBe(404);
  });

  it('a mute expires after 30 days', async () => {
    const { deps, q } = setup({}, { ai_insight: 5 });
    const app = withUser(insightsApp(deps), 'u1', q.quota);
    const first = ((await (await post(app, '/generate', OCT)).json()) as any).data.insight;
    await post(app, `/${first.id}/feedback`, { key: 'detector:noStop', useful: false });
    const later = { ...deps, now: () => new Date('2026-12-12T00:00:00Z') };
    const r = await generateInsight(later, q.quota, 'u1', OCT);
    expect(r.ok && r.insight.review!.theOne!.key).toBe('detector:noStop');
  });

  it('settings: notes are off by default; switching them on sends them and adds the notes block', async () => {
    const t = dataset().map((x, i) => (i === 0 ? { ...x, notes: 'Chased the open.' } : x));
    const { deps, q, generate } = setup({}, { ai_insight: 2 }, t);
    const app = withUser(insightsApp(deps), 'u1', q.quota);
    expect(((await (await app.request('/settings')).json()) as any).data.settings).toEqual({ useNotes: false });
    await post(app, '/generate', OCT);
    expect(JSON.stringify((generate.mock.calls[0] as any)[0].contents)).not.toContain('Chased the open');

    const put = await app.request('/settings', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ useNotes: true }) });
    expect(((await put.json()) as any).data.settings).toEqual({ useNotes: true });
    const second = ((await (await post(app, '/generate', OCT)).json()) as any).data.insight;
    expect(JSON.stringify((generate.mock.calls[1] as any)[0].contents)).toContain('Chased the open');
    expect(second.review.fromNotes).toEqual([]);
    expect((await app.request('/settings', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ useNotes: 'yes' }) })).status).toBe(400);
  });
});

describe('listInsights with an account filter (X-008)', () => {
  const insight = (n: number, accountId: string | null): Insight => ({
    id: `2026110${n}T000000000Z_0000000${n}`, createdAt: '2026-11-0' + n, period: { from: '2026-10-01', to: '2026-10-31' }, accountId, summary: `s${n}`, sections: [], model: 'm', tradeCount: 1,
  });
  const seed = async (accounts: (string | null)[]) => {
    const { store } = insightDeps([]);
    for (const [i, a] of accounts.entries()) await putInsight(store, 'u1', insight(i + 1, a), `h${i}`);
    return store;
  };

  it('limit 1 for acc1 returns the newest acc1 insight even when a newer one belongs to another account', async () => {
    const store = await seed(['acc1', null, 'other', 'other']); // newest first: 4 other, 3 other, 2 ALL, 1 acc1
    const r = await listInsights(store, 'u1', { accountId: 'acc1', limit: 1 });
    expect(r).not.toBe('invalid');
    expect((r as any).insights.map((i: Insight) => i.summary)).toEqual(['s1']);
    expect((r as any).nextCursor).toBeNull();
  });

  it('pages through matches with a cursor that continues after the last one handed out', async () => {
    const store = await seed(['a', 'x', 'a', 'x', 'x', 'a', 'x']); // newest first: x a x x a x a
    const first = (await listInsights(store, 'u1', { accountId: 'a', limit: 2 })) as any;
    expect(first.insights.map((i: Insight) => i.summary)).toEqual(['s6', 's3']);
    expect(first.nextCursor).not.toBeNull();
    const second = (await listInsights(store, 'u1', { accountId: 'a', limit: 2, cursor: first.nextCursor })) as any;
    expect(second.insights.map((i: Insight) => i.summary)).toEqual(['s1']);
    expect(second.nextCursor).toBeNull();
  });

  it('a cursor is still bound to the user and the unfiltered list is unchanged', async () => {
    const store = await seed(['a', 'b']);
    expect(await listInsights(store, 'u1', { accountId: 'a', limit: 1, cursor: 'garbage' })).toBe('invalid');
    const all = (await listInsights(store, 'u1', { limit: 5 })) as any;
    expect(all.insights.map((i: Insight) => i.summary)).toEqual(['s2', 's1']);
  });

  it('stops after a bounded number of pages and hands back a cursor to continue', async () => {
    const { store } = insightDeps([]);
    for (let i = 0; i < 250; i++) await putInsight(store, 'u1', { ...insight(1, 'x'), id: `20261101T${String(i).padStart(6, '0')}000Z_${String(i).padStart(8, '0')}`.slice(0, 25) + '', summary: `n${i}` } as Insight, 'h');
    const r = (await listInsights(store, 'u1', { accountId: 'nobody', limit: 1 })) as any;
    expect(r.insights).toEqual([]);
    expect(r.nextCursor).not.toBeNull();
  });
});

describe('scales (BE-110)', () => {
  it('5000 trades of one asset class and side, with a 5000-trade baseline, review in well under the API timeout', async () => {
    const { computeInsightInputs } = await import('../review');
    const many = (prefix: string, day: string) => Array.from({ length: 5000 }, (_, i) => trade({ id: `${prefix}${i}`, pnl: i % 3 === 0 ? -10 : 20, openDate: at(day, '04:00'), assetClass: 'stock', side: 'BUY' }));
    const t0 = performance.now();
    computeInsightInputs({ period: { from: '2026-10-05', to: '2026-10-11' }, timeZone: 'UTC', currency: 'INR', trades: many('p', '2026-10-05'), baseline: many('b', '2026-09-01'), ruleTexts: new Map(), focus: null, muted: new Set(), history: [], useNotes: false });
    expect(performance.now() - t0).toBeLessThan(5000);
  });
});
