import { describe, expect, it, vi } from 'vitest';
import { AiUnavailableError } from '../../ai/gemini';
import { fakeQuota, memoryStore, post, trade, tradeSource, withUser } from '../../__tests__/helpers';
import type { TradeRow } from '../../trades-repo';
import { computeInsightInputs } from '../metrics';
import { buildInsightRequest, INSIGHT_SYSTEM, promptMetricIds } from '../prompt';
import { insightsApp } from '../routes';
import { generateInsight } from '../service';
import { validateInsight } from '../validate';
import { listInsights, putInsight, type Insight } from '../store';

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

describe('computeInsightInputs', () => {
  const c = computeInsightInputs(dataset(), new Map());

  it('computes totals from the data, not from a model', () => {
    expect(c.metrics.trades.value).toBe(18);
    expect(c.metrics.netPnl.value).toBe(-400);
    expect(c.metrics.winRate.value).toBeCloseTo(33.33, 1);
    expect(c.metrics.avgWin.value).toBeCloseTo(100);
    expect(c.metrics.profitFactor.value).toBeCloseTo(600 / 1000, 5);
    expect(c.metrics.maxLossStreak.value).toBe(9); // the last Breakout trade (10-08) also lost
    expect(c.metrics.netPnl.display).toBe('-400.00');
  });

  it('finds the leak, ranks it first and cites only that group’s trades', () => {
    const top = c.candidates[0];
    expect(top.kind).toBe('leak');
    expect(top.impact).toBe(800);
    expect(top.tradeIds.length).toBeLessThanOrEqual(5);
    expect(top.tradeIds.every((id) => id.startsWith('r'))).toBe(true);
    expect(c.candidates.some((f) => f.kind === 'strength' && f.metricRef === 'setup.Breakout.net')).toBe(true);
  });

  it('detects revenge trades, missing stops and mistake tags', () => {
    expect(c.metrics.revengeTrades.value).toBe(7);
    expect(c.metrics.noStopTrades.value).toBe(8);
    expect(c.candidates.some((f) => f.metricRef === 'noStopNet')).toBe(true);
    expect(c.candidates.some((f) => f.metricRef === 'mistake.Revenge.net')).toBe(true);
  });

  it('is deterministic and the hash tracks the data', () => {
    expect(computeInsightInputs(dataset(), new Map()).hash).toBe(c.hash);
    const changed = dataset();
    changed[0] = { ...changed[0], pnl: 999 };
    expect(computeInsightInputs(changed, new Map()).hash).not.toBe(c.hash);
  });

  it('names broken rules from the Rules table', () => {
    const t = dataset().map((x, i) => (i < 3 ? { ...x, brokenRuleIds: ['r1'], pnl: -200 } : x));
    const r = computeInsightInputs(t, new Map([['r1', 'No trades after 2 consecutive losses']]));
    expect(r.candidates.find((f) => f.metricRef === 'rule.r1.net')?.title).toMatch(/No trades after 2 consecutive losses/);
  });
});

describe('prompt', () => {
  const c = computeInsightInputs(dataset(), new Map());
  const req = buildInsightRequest(c, { period: { from: '2026-10-01', to: '2026-10-31' }, tradeCount: 18 });

  it('offers only known metric ids and finding ids in the response schema', () => {
    const sec = (req.responseSchema as any).properties.sections.items.properties;
    expect(sec.metricRef.enum).toEqual(promptMetricIds(c));
    expect(sec.findingId.enum).toEqual(c.candidates.map((f) => f.id));
    expect(sec.kind.enum).toEqual(['strength', 'leak', 'pattern', 'action']);
  });

  it('sends computed facts only (no notes/lessons/images) and forbids advice', () => {
    const payload = req.contents[0].parts[0].text;
    expect(payload).toContain('"netPnl":{"label":"Net P&L","value":"-400.00"}');
    expect(payload).not.toMatch(/tradeNotes|lessons|images|email/i);
    expect(INSIGHT_SYSTEM).toMatch(/Never recommend buying, selling or holding/);
    expect(req.temperature).toBe(0.2);
  });
});

describe('validateInsight', () => {
  const c = computeInsightInputs(dataset(), new Map());
  const leak = c.candidates[0];

  it('drops foreign trade ids and unknown metric refs; metric values come from our map', () => {
    const v = validateInsight(
      {
        summary: 'S',
        sections: [
          { kind: 'leak', title: 'Reversal losses', body: 'b', metricRef: 'netPnl', tradeIds: ['t-foreign', 'r1'] },
          { kind: 'strength', title: 'x', body: 'y', metricRef: 'made.up' },
          { kind: 'action', title: 'a', body: 'b', metricRef: 'winRate', findingId: leak.id },
          { kind: 'bogus', title: 'z', body: 'z', metricRef: 'netPnl' },
        ],
      },
      c,
    );
    const first = v.sections[0];
    expect(first.metric).toEqual(c.metrics.netPnl);
    expect(first.tradeIds).toEqual(['r1']);
    expect(v.sections[1].metric).toBeUndefined();
    expect(v.sections[2].tradeIds).toEqual(leak.tradeIds);
    expect(v.sections.map((s) => s.kind)).not.toContain('bogus');
  });

  it('fills a missing strength/leak/action from deterministic candidates and keeps 3-8 sections', () => {
    const v = validateInsight({ summary: '', sections: [] }, c);
    const kinds = v.sections.map((s) => s.kind);
    expect(kinds).toEqual(expect.arrayContaining(['strength', 'leak', 'action']));
    expect(v.sections.length).toBeGreaterThanOrEqual(3);
    expect(v.sections.length).toBeLessThanOrEqual(8);
    expect(v.summary).toBe('18 trades, net -400.00, win rate 33.33%.');
    const cited = v.sections.flatMap((s) => s.tradeIds ?? []);
    expect(cited.every((id) => c.tradeIds.has(id))).toBe(true);
  });

  it('eight model sections that are all patterns still end with a strength, a leak and an action (BE-049)', () => {
    const patterns = Array.from({ length: 8 }, (_, i) => ({ kind: 'pattern', title: `Pattern ${i}`, body: `body ${i}`, metricRef: 'netPnl' }));
    const v = validateInsight({ summary: 'S', sections: patterns }, c);
    const kinds = v.sections.map((s) => s.kind);
    expect(v.sections).toHaveLength(8);
    for (const required of ['strength', 'leak', 'action']) expect(kinds.filter((k) => k === required)).toHaveLength(1);
    // the earliest patterns are kept, the surplus ones are dropped from the end
    expect(v.sections.filter((s) => s.kind === 'pattern').map((s) => s.title)).toEqual(['Pattern 0', 'Pattern 1', 'Pattern 2', 'Pattern 3', 'Pattern 4']);
  });

  it('a model answer that already has all three kinds is not reshuffled', () => {
    const sections = [
      ...Array.from({ length: 5 }, (_, i) => ({ kind: 'pattern', title: `P${i}`, body: 'b' })),
      { kind: 'strength', title: 'S', body: 'b' }, { kind: 'leak', title: 'L', body: 'b' }, { kind: 'action', title: 'A', body: 'b' },
    ];
    expect(validateInsight({ summary: 'S', sections }, c).sections.map((s) => s.title)).toEqual(['P0', 'P1', 'P2', 'P3', 'P4', 'S', 'L', 'A']);
  });

  it('clamps lengths and survives garbage', () => {
    const v = validateInsight({ summary: 'x'.repeat(900), sections: [{ kind: 'leak', title: 't'.repeat(200), body: 'b'.repeat(2000), metricRef: 'netPnl' }] }, c);
    expect(v.summary).toHaveLength(400);
    expect(v.sections[0].title).toHaveLength(80);
    expect(v.sections[0].body).toHaveLength(600);
    expect(() => validateInsight('nonsense', c)).not.toThrow();
    expect(() => validateInsight(null, c)).not.toThrow();
  });
});

const modelJson = (c: ReturnType<typeof computeInsightInputs>) =>
  JSON.stringify({
    summary: 'You lose money on reversals.',
    sections: [
      { kind: 'leak', title: 'Reversal setup loses', body: 'Reversal trades lost money.', metricRef: 'netPnl', findingId: c.candidates[0].id },
      { kind: 'strength', title: 'Breakout works', body: 'Breakouts are profitable.', metricRef: 'winRate' },
      { kind: 'action', title: 'Set stops', body: 'Always set a stop.', metricRef: 'noStopTrades' },
    ],
  });

function setup(over: Partial<Parameters<typeof generateInsight>[0]> = {}, limits = { ai_insight: 1 }) {
  const trades = dataset();
  const generate = vi.fn(async () => ({ text: modelJson(computeInsightInputs(trades, new Map([['r1', 'No trades after 2 consecutive losses']]))), model: 'gemini-test', usage: { promptTokens: 1, outputTokens: 1 } }));
  const store = memoryStore();
  const deps = { store, trades: tradeSource(trades), generate, now: () => new Date('2026-11-11T10:00:00Z'), ...over };
  return { deps, store, generate, q: fakeQuota(limits) };
}

describe('generateInsight', () => {
  it('generates, stores and cites only the user’s own trade ids', async () => {
    const { deps, store, generate, q } = setup();
    const r = await generateInsight(deps, q.quota, 'u1', { from: '2026-10-01', to: '2026-10-31' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(generate).toHaveBeenCalledTimes(1);
    expect(r.insight.tradeCount).toBe(18);
    expect(r.insight.sections.length).toBeGreaterThanOrEqual(3);
    const own = new Set(dataset().map((t) => t.id));
    expect(r.insight.sections.flatMap((s) => s.tradeIds ?? []).every((id) => id.startsWith('b') || id.startsWith('r') || own.has(id))).toBe(true);
    expect(q.used.ai_insight).toBe(1);
    expect(store.items.size).toBe(1);
  });

  it('marks the insight truncated when the period held more trades than could be loaded', async () => {
    const { deps, q } = setup({ trades: tradeSource(dataset(), [], true) });
    const r = await generateInsight(deps, q.quota, 'u1', { from: '2026-10-01', to: '2026-10-31' });
    expect(r.ok && r.insight.truncated).toBe(true);
    const normal = setup();
    const n = await generateInsight(normal.deps, normal.q.quota, 'u1', { from: '2026-10-01', to: '2026-10-31' });
    expect(n.ok && n.insight.truncated).toBeUndefined();
  });

  it('serves a cached insight for the same data without Gemini or quota', async () => {
    const { deps, generate, q } = setup();
    const first = await generateInsight(deps, q.quota, 'u1', { from: '2026-10-01', to: '2026-10-31' });
    const second = await generateInsight(deps, q.quota, 'u1', { from: '2026-10-01', to: '2026-10-31' });
    expect(second.ok && second.cached).toBe(true);
    expect(second.ok && first.ok && second.insight.id === first.insight.id).toBe(true);
    expect(generate).toHaveBeenCalledTimes(1);
    expect(q.calls).toHaveLength(1);
  });

  describe('one generation at a time for the same inputs (BE-109)', () => {
    const input = { from: '2026-10-01', to: '2026-10-31' };

    it('a double click uses one unit and one Gemini call: the second request is a 409, or the finished insight', async () => {
      const { deps, generate, q, store } = setup();
      const results = await Promise.all([generateInsight(deps, q.quota, 'u1', input), generateInsight(deps, q.quota, 'u1', input)]);
      expect(results.every((r) => r.ok || (r.status === 409 && r.code === 'IN_PROGRESS'))).toBe(true);
      expect(results.filter((r) => r.ok && !r.cached)).toHaveLength(1);
      expect(generate).toHaveBeenCalledTimes(1);
      expect(q.used.ai_insight).toBe(1);
      expect([...store.items.values()].some((i) => i.sk.startsWith('INSIGHT-CLAIM#'))).toBe(false);
    });

    it('the claim is released when the quota is exhausted and when Gemini fails, so a retry can run', async () => {
      const full = setup({}, { ai_insight: 0 });
      expect(await generateInsight(full.deps, full.q.quota, 'u1', input)).toMatchObject({ ok: false, status: 402 });
      expect([...full.store.items.values()]).toHaveLength(0);

      const down = setup({ generate: vi.fn().mockRejectedValue(new AiUnavailableError('down', 'm', 503)) });
      expect(await generateInsight(down.deps, down.q.quota, 'u1', input)).toMatchObject({ ok: false, status: 502 });
      expect([...down.store.items.values()]).toHaveLength(0);
      expect(down.q.used.ai_insight).toBe(0);
    });

    it('a claim left by a crashed run blocks only until it expires', async () => {
      const { deps, store, q, generate } = setup({}, { ai_insight: 5 });
      const base = await generateInsight(deps, q.quota, 'u1', input); // learn the hash through the stored insight
      expect(base.ok).toBe(true);
      const hash = [...store.items.values()].find((i) => i.entity === 'insight')!.metricsHash as string;
      // a different period with the same metrics hash is not blocked by this claim key, so use the real key shape
      const sk = `INSIGHT-CLAIM#ALL#${input.from}#${input.to}#${hash}`;
      store.items.clear();
      await store.putIfFree({ userId: 'u1', sk, entity: 'insight-claim', expiresAt: deps.now().getTime() + 60_000 }, deps.now().getTime());
      expect(await generateInsight(deps, q.quota, 'u1', input)).toMatchObject({ ok: false, status: 409 });
      store.items.clear();
      await store.putIfFree({ userId: 'u1', sk, entity: 'insight-claim', expiresAt: deps.now().getTime() - 1 }, deps.now().getTime() - 5);
      const later = await generateInsight(deps, q.quota, 'u1', input);
      expect(later.ok).toBe(true);
      expect(generate).toHaveBeenCalledTimes(2);
    });
  });

  it('422 below five trades, no quota used', async () => {
    const { deps, q } = setup({ trades: tradeSource(dataset().slice(0, 4)) });
    const r = await generateInsight(deps, q.quota, 'u1', { from: '2026-10-01', to: '2026-10-31' });
    expect(r).toMatchObject({ ok: false, status: 422, code: 'NOT_ENOUGH_TRADES' });
    expect(q.calls).toHaveLength(0);
  });

  it('402 when the quota is exhausted and Gemini is not called', async () => {
    const { deps, generate, q } = setup({}, { ai_insight: 0 });
    const r = await generateInsight(deps, q.quota, 'u1', { from: '2026-10-01', to: '2026-10-31' });
    expect(r).toMatchObject({ ok: false, status: 402, quota: { limit: 0 } });
    expect(generate).not.toHaveBeenCalled();
  });

  it('refunds the unit and returns 502 when Gemini fails', async () => {
    const { deps, q } = setup({ generate: vi.fn(async () => { throw new AiUnavailableError('down'); }) as any });
    const r = await generateInsight(deps, q.quota, 'u1', { from: '2026-10-01', to: '2026-10-31' });
    expect(r).toMatchObject({ ok: false, status: 502, code: 'AI_UNAVAILABLE' });
    expect(q.used.ai_insight).toBe(0);
    expect(q.calls.map((x) => x[1])).toEqual([1, -1]);
  });

  it('logs one structured warn line (feature, model, status, message) when Gemini is unavailable', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      const err = new AiUnavailableError('gemini-2.5-flash 429 Quota exceeded for metric', 'gemini-2.5-flash', 429);
      const { deps, q } = setup({ generate: vi.fn(async () => { throw err; }) as any });
      await generateInsight(deps, q.quota, 'u1', { from: '2026-10-01', to: '2026-10-31' }, 'req-9');
      const lines = log.mock.calls.map((c) => String(c[0])).filter((l) => l.includes('ai_unavailable'));
      expect(lines).toHaveLength(1);
      expect(JSON.parse(lines[0])).toMatchObject({ level: 'WARN', msg: 'ai_unavailable', feature: 'insights', model: 'gemini-2.5-flash', status: 429, error: 'gemini-2.5-flash 429 Quota exceeded for metric', requestId: 'req-9', userId: 'u1' });
      expect(lines[0]).not.toMatch(/NIFTY|Breakout|Reversal|"pnl"/);
    } finally {
      log.mockRestore();
    }
  });

  it('survives non-JSON model output with a deterministic insight', async () => {
    const { deps, q } = setup({ generate: vi.fn(async () => ({ text: 'not json', model: 'm', usage: { promptTokens: 0, outputTokens: 0 } })) as any });
    const r = await generateInsight(deps, q.quota, 'u1', { from: '2026-10-01', to: '2026-10-31' });
    expect(r.ok && r.insight.sections.length).toBeGreaterThanOrEqual(3);
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
});

describe('insights routes', () => {
  it('generate → list → get, with per-user isolation and cursor binding', async () => {
    const { deps, q } = setup();
    const app = withUser(insightsApp(deps), 'u1', q.quota);
    const gen = await post(app, '/generate', { from: '2026-10-01', to: '2026-10-31' });
    expect(gen.status).toBe(200);
    const { data } = (await gen.json()) as any;
    expect(data.insight.sections.length).toBeGreaterThanOrEqual(3);

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

  it('maps quota exhaustion to the 402 contract shape', async () => {
    const { deps, q } = setup({}, { ai_insight: 0 });
    const res = await post(withUser(insightsApp(deps), 'u1', q.quota), '/generate', { from: '2026-10-01', to: '2026-10-31' });
    expect(res.status).toBe(402);
    expect(await res.json()).toMatchObject({ success: false, errorCode: 'QUOTA_EXCEEDED', error: { code: 'QUOTA_EXCEEDED', feature: 'ai_insight', limit: 0, resetsAt: '2026-12-01T00:00:00.000Z' } });
  });
});

describe('listInsights with an account filter (X-008)', () => {
  const insight = (n: number, accountId: string | null): Insight => ({
    id: `2026110${n}T000000000Z_0000000${n}`, createdAt: '2026-11-0' + n, period: { from: '2026-10-01', to: '2026-10-31' }, accountId, summary: `s${n}`, sections: [], model: 'm', tradeCount: 1,
  });
  const seed = async (accounts: (string | null)[]) => {
    const store = memoryStore();
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
    const store = memoryStore();
    for (let i = 0; i < 250; i++) await putInsight(store, 'u1', { ...insight(1, 'x'), id: `20261101T${String(i).padStart(6, '0')}000Z_${String(i).padStart(8, '0')}`.slice(0, 25) + '', summary: `n${i}` } as Insight, 'h');
    const r = (await listInsights(store, 'u1', { accountId: 'nobody', limit: 1 })) as any;
    expect(r.insights).toEqual([]);
    expect(r.nextCursor).not.toBeNull();
  });
});

describe('groupMany scales (BE-110)', () => {
  it('5000 trades of one asset class and side compute in well under a second', () => {
    const many = Array.from({ length: 5000 }, (_, i) => trade({ id: `t${i}`, pnl: i % 3 === 0 ? -10 : 20, openDate: at('2026-10-05', '04:00'), assetClass: 'stock', side: 'BUY' }));
    const t0 = performance.now();
    computeInsightInputs(many, new Map());
    expect(performance.now() - t0).toBeLessThan(1000);
  });
});

