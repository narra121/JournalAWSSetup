import { describe, expect, it, vi } from 'vitest';
import { AiUnavailableError } from '../../ai/gemini';
import { SseParser } from '../../ai/sse';
import { fakeQuota, memoryStore, post, trade, tradeSource, withUser } from '../../__tests__/helpers';
import type { TradeRow } from '../../trades-repo';
import { buildChatContext, chatPeriod, selectTrades } from '../context';
import { __resetChatContextCache, chatApp, citedTradeIds, type ChatDeps } from '../routes';

const trades: TradeRow[] = [
  trade({ id: 'real1', pnl: 500, openDate: '2026-11-02T04:00:00.000Z', symbol: 'BANKNIFTY', setupType: 'Breakout' }),
  trade({ id: 'real2', pnl: -300, openDate: '2026-11-03T04:00:00.000Z', symbol: 'NIFTY', setupType: 'Reversal', mistakes: ['FOMO'] }),
  ...Array.from({ length: 12 }, (_, i) => trade({ id: `x${i}`, pnl: i % 2 ? 40 : -40, openDate: `2026-11-0${(i % 8) + 1}T05:00:00.000Z`, symbol: 'SBIN' })),
];

interface Ev { event: string; data: any }
async function readSse(res: Response): Promise<Ev[]> {
  const p = new SseParser();
  const out = [...p.push(await res.text()), ...p.end()];
  return out.map((e) => ({ event: e.event, data: JSON.parse(e.data) }));
}

function setup(opts: { chunks?: (string | Error)[]; limits?: Record<string, number> } = {}) {
  __resetChatContextCache();
  const chunks = opts.chunks ?? ['Your best trade ', 'was [#real1]. ', 'Also [#fake9] and ', '[#real2].'];
  const stream = vi.fn(async function* () {
    for (const c of chunks) {
      if (c instanceof Error) throw c;
      yield { type: 'text' as const, text: c };
    }
    yield { type: 'end' as const, model: 'gemini-test', usage: { promptTokens: 120, outputTokens: 30 } };
  });
  const store = memoryStore();
  const deps: ChatDeps = { store, trades: tradeSource(trades), stream: stream as any, now: () => new Date('2026-11-11T10:00:00Z'), pingMs: 60_000 };
  const q = fakeQuota(opts.limits ?? { ai_chat: 10 });
  const app = withUser(chatApp(deps), 'u1', q.quota);
  return { deps, store, stream, q, app };
}

async function newSession(app: ReturnType<typeof setup>['app']) {
  const r = await post(app, '/sessions', {});
  return (((await r.json()) as any).data.session.id) as string;
}

describe('chat sessions', () => {
  it('create → list → delete removes the session and its messages', async () => {
    const { app, store } = setup();
    const id = await newSession(app);
    await post(app, `/sessions/${id}/messages`, { content: 'How did I do?' }).then((r) => r.text());
    expect(store.items.size).toBe(3); // session + 2 messages
    expect(((await (await app.request('/sessions')).json()) as any).data.sessions).toHaveLength(1);
    const del = await app.request(`/sessions/${id}`, { method: 'DELETE' });
    expect(await del.json()).toMatchObject({ data: { deleted: true } });
    expect(store.items.size).toBe(0);
    expect((await app.request(`/sessions/${id}/messages`)).status).toBe(404);
  });

  it('rejects a linked insight that is not the user’s, a bad id and another user’s session', async () => {
    const { app, deps, q } = setup();
    expect((await post(app, '/sessions', { insightId: '20260101T000000000Z_deadbeef' })).status).toBe(404);
    expect((await app.request('/sessions/nope/messages')).status).toBe(404);
    const id = await newSession(app);
    const other = withUser(chatApp(deps), 'u2', q.quota);
    expect((await post(other, `/sessions/${id}/messages`, { content: 'hi' })).status).toBe(404);
    expect((await other.request(`/sessions/${id}`, { method: 'DELETE' })).status).toBe(404);
  });
});

describe('POST /sessions/:id/messages', () => {
  it('streams ≥3 token events then done, persists both messages and links only own trades', async () => {
    const { app, stream, q } = setup();
    const id = await newSession(app);
    const res = await post(app, `/sessions/${id}/messages`, { content: 'Which setup lost me the most money?' });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/text\/event-stream/);
    const events = await readSse(res);
    expect(events.filter((e) => e.event === 'token').length).toBeGreaterThanOrEqual(3);
    const done = events.find((e) => e.event === 'done')!;
    expect(done.data).toMatchObject({ usage: { promptTokens: 120, outputTokens: 30, remaining: 9 }, tradeIds: ['real1', 'real2'] });
    expect(done.data.disclaimer).toMatch(/Not investment advice/);
    expect(events[events.length - 1].event).toBe('done');
    expect(stream).toHaveBeenCalledTimes(1);
    expect(q.used.ai_chat).toBe(1);

    const msgs = ((await (await app.request(`/sessions/${id}/messages`)).json()) as any).data.messages;
    expect(msgs.map((m: any) => m.role)).toEqual(['user', 'assistant']);
    expect(msgs[1].content).toBe('Your best trade was [#real1]. Also [#fake9] and [#real2].');
    expect(msgs[1].tradeIds).toEqual(['real1', 'real2']);
    const session = ((await (await app.request('/sessions')).json()) as any).data.sessions[0];
    expect(session).toMatchObject({ messageCount: 2, title: 'Which setup lost me the most money?' });
  });

  it('the model request carries the data block, history and the system rules', async () => {
    const { app, stream } = setup();
    const id = await newSession(app);
    await post(app, `/sessions/${id}/messages`, { content: 'first question' }).then((r) => r.text());
    await post(app, `/sessions/${id}/messages`, { content: 'and BANKNIFTY?' }).then((r) => r.text());
    const req = (stream.mock.calls[1] as any[])[0];
    expect(req.system).toMatch(/not a SEBI-registered investment adviser/);
    expect(req.system).toContain('DATA (JSON)');
    expect(req.system).toContain('real1');
    expect(req.contents.map((c: any) => c.role)).toEqual(['user', 'model', 'user']);
    expect(req.contents[2].parts[0].text).toBe('and BANKNIFTY?');
  });

  it('flags truncated trade data in the done event and tells the model the data is partial', async () => {
    const { stream, deps, q } = setup();
    const app = withUser(chatApp({ ...deps, trades: tradeSource(trades, [], true) }), 'u1', q.quota);
    const id = await newSession(app);
    const events = await readSse(await post(app, `/sessions/${id}/messages`, { content: 'how am i doing?' }));
    expect(events.find((e) => e.event === 'done')!.data.truncated).toBe(true);
    expect((stream.mock.calls[0] as any[])[0]).toMatchObject({ system: expect.stringContaining('Partial data') });
    const plain = setup();
    const id2 = await newSession(plain.app);
    const done = (await readSse(await post(plain.app, `/sessions/${id2}/messages`, { content: 'how am i doing?' }))).find((e) => e.event === 'done')!;
    expect(done.data).not.toHaveProperty('truncated');
  });

  it('refuses buy/sell advice without quota or Gemini, still streams tokens and a done event', async () => {
    const { app, stream, q } = setup();
    const id = await newSession(app);
    const res = await post(app, `/sessions/${id}/messages`, { content: 'Should I buy BANKNIFTY call options tomorrow morning? Give me an entry and target.' });
    const events = await readSse(res);
    expect(stream).not.toHaveBeenCalled();
    expect(q.calls).toHaveLength(0);
    expect(events.filter((e) => e.event === 'token').length).toBeGreaterThanOrEqual(3);
    const text = events.filter((e) => e.event === 'token').map((e) => e.data.t).join('');
    expect(text).toMatch(/can't recommend/);
    expect(events.find((e) => e.event === 'done')!.data).toMatchObject({ refused: true, tradeIds: [] });
  });

  it('answers the 11th message with 402 QUOTA_EXCEEDED JSON and stores nothing', async () => {
    const { app, store } = setup({ limits: { ai_chat: 1 } });
    const id = await newSession(app);
    await post(app, `/sessions/${id}/messages`, { content: 'one' }).then((r) => r.text());
    const before = store.items.size;
    const res = await post(app, `/sessions/${id}/messages`, { content: 'two' });
    expect(res.status).toBe(402);
    expect(await res.json()).toMatchObject({ errorCode: 'QUOTA_EXCEEDED', error: { feature: 'ai_chat', limit: 1 } });
    expect(store.items.size).toBe(before);
  });

  it('upstream failure before any token refunds the unit and emits an error event', async () => {
    const { app, q } = setup({ chunks: [new Error('gemini down')] });
    const id = await newSession(app);
    const events = await readSse(await post(app, `/sessions/${id}/messages`, { content: 'hello' }));
    expect(events.map((e) => e.event)).toEqual(['error']);
    expect(events[0].data.code).toBe('AI_UNAVAILABLE');
    expect(q.used.ai_chat).toBe(0);
    const msgs = ((await (await app.request(`/sessions/${id}/messages`)).json()) as any).data.messages;
    expect(msgs.map((m: any) => m.role)).toEqual(['user']);
  });

  it('logs one structured warn line with model, status and the provider message, never prompt or trade text', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      const { app } = setup({ chunks: [new AiUnavailableError('gemini-2.5-flash 429 You exceeded your current quota', 'gemini-2.5-flash', 429)] });
      const id = await newSession(app);
      await readSse(await post(app, `/sessions/${id}/messages`, { content: 'secret question about BANKNIFTY' }));
      const lines = log.mock.calls.map((c) => String(c[0])).filter((l) => l.includes('ai_unavailable'));
      expect(lines).toHaveLength(1);
      const entry = JSON.parse(lines[0]);
      expect(entry).toMatchObject({ level: 'WARN', msg: 'ai_unavailable', feature: 'chat', model: 'gemini-2.5-flash', status: 429, userId: 'u1', errorType: 'Error' });
      expect(entry.error).toBe('gemini-2.5-flash 429 You exceeded your current quota');
      expect(lines[0]).not.toMatch(/BANKNIFTY|secret question|real1|DATA \(JSON\)/);
    } finally {
      log.mockRestore();
    }
  });

  it('failure after tokens keeps the partial answer, keeps the unit used and sends error, not done', async () => {
    const { app, q } = setup({ chunks: ['Partial ', 'answer ', new Error('cut')] });
    const id = await newSession(app);
    const events = await readSse(await post(app, `/sessions/${id}/messages`, { content: 'hello' }));
    expect(events.map((e) => e.event)).toEqual(['token', 'token', 'error']);
    expect(q.used.ai_chat).toBe(1);
  });

  it.each([[''], ['   '], ['x'.repeat(2001)]])('rejects content %#', async (content) => {
    const { app } = setup();
    const id = await newSession(app);
    expect((await post(app, `/sessions/${id}/messages`, { content })).status).toBe(400);
  });

  it('caps a session at 100 messages', async () => {
    const { app, store } = setup();
    const id = await newSession(app);
    const key = [...store.items.keys()].find((k) => k.includes('CHAT#'))!;
    const item = store.items.get(key)!;
    store.items.set(key, { ...item, messageCount: 100 });
    const res = await post(app, `/sessions/${id}/messages`, { content: 'more' });
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({ errorCode: 'SESSION_FULL' });
  });
});

describe('empty replies, cancellation and the session counter', () => {
  const sessionOf = (store: ReturnType<typeof memoryStore>, id: string) => [...store.items.values()].find((i) => i.sk === `CHAT#${id}`)!;

  it('a reply with no text (blocked or empty) refunds the unit and sends an error, not done (BE-047)', async () => {
    const { app, q, store } = setup({ chunks: [] });
    const id = await newSession(app);
    const events = await readSse(await post(app, `/sessions/${id}/messages`, { content: 'Why do I lose on Mondays?' }));
    expect(events.map((e) => e.event)).toEqual(['error']);
    expect(events[0].data.code).toBe('AI_UNAVAILABLE');
    expect(q.used.ai_chat).toBe(0);
    expect(sessionOf(store, id).messageCount).toBe(1); // only the user's message is stored
  });

  it('the model call gets a signal that fires when the client cancels (BE-048)', async () => {
    const { app, stream } = setup();
    const id = await newSession(app);
    const ctrl = new AbortController();
    const res = await app.request(`/sessions/${id}/messages`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ content: 'Which setup lost me the most money?' }), signal: ctrl.signal,
    });
    await res.text();
    const req = (stream.mock.calls[0] as any[])[0];
    expect(req.signal).toBeInstanceOf(AbortSignal);
    expect(req.signal.aborted).toBe(false);
    const reader = (await app.request(`/sessions/${id}/messages`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ content: 'Which symbol lost me the most?' }),
    })).body!.getReader();
    await reader.cancel();
    expect(((stream.mock.calls[1] as any[])[0]).signal.aborted).toBe(true);
  });

  it('two messages posted at once cannot both pass the 100-message cap (BE-108)', async () => {
    const { app, store } = setup();
    const id = await newSession(app);
    sessionOf(store, id).messageCount = 98;
    const [a, b] = await Promise.all([
      post(app, `/sessions/${id}/messages`, { content: 'Which setup lost me the most money?' }),
      post(app, `/sessions/${id}/messages`, { content: 'Which symbol lost me the most money?' }),
    ]);
    await Promise.all([a.text(), b.text()]);
    expect([a.status, b.status].sort()).toEqual([200, 422]);
    expect(sessionOf(store, id).messageCount).toBe(100);
  });

  it('a refused advice message does not take the session over its counter and is rate limited per minute (BE-108)', async () => {
    const { deps, store, q } = setup();
    let allowed = 2;
    const app = withUser(chatApp({ ...deps, refusalAllowed: async () => allowed-- > 0 }), 'u1', q.quota);
    const id = await newSession(app);
    for (let i = 0; i < 2; i++) expect((await post(app, `/sessions/${id}/messages`, { content: 'Which stock should I buy for intraday?' })).status).toBe(200);
    const limited = await post(app, `/sessions/${id}/messages`, { content: 'Which stock should I buy for intraday?' });
    expect(limited.status).toBe(429);
    expect(((await limited.json()) as any).error.retryAfter).toBe(60);
    expect(q.used.ai_chat ?? 0).toBe(0);
    expect(sessionOf(store, id).messageCount).toBe(4);
  });

  it('a full session is refused without keeping the quota unit', async () => {
    const { app, store, q } = setup();
    const id = await newSession(app);
    sessionOf(store, id).messageCount = 100;
    const res = await post(app, `/sessions/${id}/messages`, { content: 'hi there' });
    expect(res.status).toBe(422);
    expect(q.used.ai_chat ?? 0).toBe(0);
  });
});

describe('the loaded period is reused between messages (BE-056)', () => {
  it('loads trades and rules once for a conversation within a minute, per user and period', async () => {
    const { deps, store, q } = setup();
    const load = vi.spyOn(deps.trades, 'loadTrades');
    const rules = vi.spyOn(deps.trades, 'loadRuleTexts');
    const app = withUser(chatApp(deps), 'u1', q.quota);
    const id = await newSession(app);
    for (const content of ['Which setup lost me the most money?', 'And which symbol?', 'What about Mondays?']) await post(app, `/sessions/${id}/messages`, { content }).then((r) => r.text());
    expect(load).toHaveBeenCalledTimes(1);
    expect(rules).toHaveBeenCalledTimes(1);
    expect(store.items.size).toBe(7);

    const other = withUser(chatApp(deps), 'u2', q.quota);
    const id2 = await newSession(other);
    await post(other, `/sessions/${id2}/messages`, { content: 'Which setup lost me the most money?' }).then((r) => r.text());
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('reloads after the minute has passed', async () => {
    const { deps, q } = setup();
    const load = vi.spyOn(deps.trades, 'loadTrades');
    let t = Date.parse('2026-11-11T10:00:00Z');
    const app = withUser(chatApp({ ...deps, now: () => new Date(t) }), 'u1', q.quota);
    const id = await newSession(app);
    await post(app, `/sessions/${id}/messages`, { content: 'Which setup lost me the most money?' }).then((r) => r.text());
    t += 61_000;
    await post(app, `/sessions/${id}/messages`, { content: 'And which symbol?' }).then((r) => r.text());
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('the chat computes only the base metrics (no breakdowns or findings)', () => {
    const ctx = buildChatContext('how am I doing', trades, new Map(), null, { from: '2026-11-01', to: '2026-11-11' });
    const data = JSON.parse(ctx.text.replace('DATA (JSON):\n', ''));
    expect(Object.keys(data.metrics)).toContain('netPnl');
    expect(Object.keys(data.metrics).some((k) => k.includes('.net') || k.startsWith('mistake'))).toBe(false);
  });
});

describe('trade references (B-112)', () => {
  it('keeps only ids the user owns, once each', () => {
    expect(citedTradeIds('See [#a1], [#a1], [#zz] and [# bad]', new Set(['a1', 'b2']))).toEqual(['a1']);
    expect(citedTradeIds('no refs', new Set(['a1']))).toEqual([]);
  });
});

describe('context', () => {
  it('uses the insight period or the last 90 days', () => {
    expect(chatPeriod(null, new Date('2026-11-11T10:00:00Z'))).toEqual({ from: '2026-08-13', to: '2026-11-11', accountId: null });
    expect(chatPeriod({ period: { from: '2026-10-01', to: '2026-10-31' }, accountId: 'a' } as any, new Date())).toEqual({ from: '2026-10-01', to: '2026-10-31', accountId: 'a' });
  });

  it('selects trades the question mentions, else best/worst/latest', () => {
    expect(selectTrades('how is banknifty doing', trades).map((t) => t.id)).toEqual(['real1']);
    expect(selectTrades('what about FOMO', trades).map((t) => t.id)).toEqual(['real2']);
    expect(selectTrades('how am i doing overall', trades).length).toBeLessThanOrEqual(30);
    expect(selectTrades('trades on monday', trades).every((t) => new Date(Date.parse(t.openDate) + 330 * 60_000).getUTCDay() === 1)).toBe(true);
  });

  it('data block has metrics and trades, never notes or images', () => {
    const c = buildChatContext('overall', trades.map((t) => ({ ...t })), new Map(), null, { from: '2026-08-13', to: '2026-11-11' });
    expect(c.text).toContain('"netPnl"');
    expect(c.text).not.toMatch(/notes|lessons|image|email/i);
    expect(c.knownTradeIds.has('real1')).toBe(true);
  });
});
