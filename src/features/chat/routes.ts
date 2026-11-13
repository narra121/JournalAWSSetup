import { Hono } from 'hono';
import type { AppEnv } from '../../app/types';
import { stream as geminiStream, type GeminiContent } from '../ai/gemini';
import { logAiFailure } from '../ai/log';
import { sseFrame, ssePing } from '../ai/sse';
import { fail, ok, quotaFail, readJson } from '../http';
import { timeId } from '../ids';
import { getInsight } from '../insights/store';
import { dynamoAiStore, type AiStore } from '../store';
import { dynamoTradeSource, type TradeSource } from '../trades-repo';
import { buildChatContext, chatPeriod } from './context';
import { ADVICE_REFUSAL, DISCLAIMER, isAdviceRequest } from './guard';
import { CHAT_SYSTEM, TRADE_REF } from './prompt';
import { addMessages, deleteSession, getSession, listMessages, listSessions, MAX_SESSION_MESSAGES, putMessage, putSession, touchSession, type ChatMessage, type ChatSession } from './store';
import { checkRateLimit } from '../../handlers/auth-rate-limit-wrapper/rateLimit';

export interface ChatDeps {
  store: AiStore;
  trades: TradeSource;
  stream: typeof geminiStream;
  now: () => Date;
  pingMs: number;
  /** Cheap per-user limit for messages that are refused before any model call (they cost no quota); true = allowed. */
  refusalAllowed?: (userId: string) => Promise<boolean>;
}

const REFUSALS_PER_MINUTE = 10;

/**
 * The loaded period (trades and rule texts) of a user, kept for a minute: every message of a conversation asks for the same
 * period, and loading it is 50+ DynamoDB round trips at 5,000 trades. A trade saved in that minute shows up in the next one.
 */
const CONTEXT_TTL_MS = 60_000;
const CONTEXT_CACHE_MAX = 50;
const contextCache = new Map<string, { at: number; loaded: Awaited<ReturnType<TradeSource['loadTrades']>>; rules: Map<string, string> }>();

/** Test hook. */
export function __resetChatContextCache() {
  contextCache.clear();
}

async function loadPeriod(deps: ChatDeps, userId: string, period: { from: string; to: string; accountId: string | null }) {
  const key = `${userId}|${period.accountId ?? 'ALL'}|${period.from}|${period.to}`;
  const now = deps.now().getTime();
  const hit = contextCache.get(key);
  if (hit && now - hit.at < CONTEXT_TTL_MS) return hit;
  const [loaded, rules] = await Promise.all([deps.trades.loadTrades(userId, period), deps.trades.loadRuleTexts(userId)]);
  const entry = { at: now, loaded, rules };
  contextCache.delete(key);
  contextCache.set(key, entry);
  if (contextCache.size > CONTEXT_CACHE_MAX) contextCache.delete(contextCache.keys().next().value!);
  return entry;
}
export const defaultChatDeps: ChatDeps = {
  store: dynamoAiStore, trades: dynamoTradeSource, stream: geminiStream, now: () => new Date(), pingMs: 15_000,
  refusalAllowed: async (userId) => (await checkRateLimit({ key: `chat-refused:${userId}`, limit: REFUSALS_PER_MINUTE, windowSeconds: 60 })).allowed,
};

const MAX_CONTENT = 2000;
const TITLE_MAX = 60;
const HISTORY_TURNS = 10;
const SSE_HEADERS = { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache, no-transform', 'x-accel-buffering': 'no' };

const sentences = (text: string) => text.split(/(?<=[.?!])\s+/).filter(Boolean).map((s, i) => (i ? ` ${s}` : s));

/** `[#id]` references in the answer that belong to the user's own trades; invented or foreign ids are dropped. */
export function citedTradeIds(text: string, known: Set<string>): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(TRADE_REF)) if (known.has(m[1])) out.add(m[1]);
  return [...out];
}

export function chatApp(deps: ChatDeps = defaultChatDeps): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.post('/sessions', async (c) => {
    const body = await readJson(c);
    if (!body) return fail(c, 400, 'VALIDATION_ERROR', 'Request body must be a JSON object.');
    const userId = c.get('userId');
    if (body.title != null && (typeof body.title !== 'string' || body.title.length > 80)) return fail(c, 400, 'VALIDATION_ERROR', 'title must be a string of at most 80 characters.');
    if (body.insightId != null) {
      if (typeof body.insightId !== 'string' || !(await getInsight(deps.store, userId, body.insightId))) return fail(c, 404, 'NOT_FOUND', 'Insight not found.');
    }
    const now = deps.now().toISOString();
    const session: ChatSession = { id: timeId(deps.now()), title: (body.title as string | undefined)?.trim() || '', createdAt: now, updatedAt: now, messageCount: 0, ...(body.insightId ? { insightId: body.insightId as string } : {}) };
    await putSession(deps.store, userId, session);
    return ok(c, { session }, 201);
  });

  app.get('/sessions', async (c) => ok(c, { sessions: await listSessions(deps.store, c.get('userId')) }));

  app.get('/sessions/:id/messages', async (c) => {
    const userId = c.get('userId');
    if (!(await getSession(deps.store, userId, c.req.param('id')))) return fail(c, 404, 'NOT_FOUND', 'Chat session not found.');
    return ok(c, { messages: await listMessages(deps.store, userId, c.req.param('id')) });
  });

  app.delete('/sessions/:id', async (c) => {
    const userId = c.get('userId');
    if (!(await getSession(deps.store, userId, c.req.param('id')))) return fail(c, 404, 'NOT_FOUND', 'Chat session not found.');
    await deleteSession(deps.store, userId, c.req.param('id'));
    return ok(c, { deleted: true });
  });

  app.post('/sessions/:id/messages', async (c) => {
    const userId = c.get('userId');
    const sessionId = c.req.param('id');
    const body = await readJson(c);
    const content = typeof body?.content === 'string' ? body.content.trim() : '';
    if (!content || content.length > MAX_CONTENT) return fail(c, 400, 'VALIDATION_ERROR', `content is required (1-${MAX_CONTENT} characters).`);
    const session = await getSession(deps.store, userId, sessionId);
    if (!session) return fail(c, 404, 'NOT_FOUND', 'Chat session not found.');
    if (session.messageCount >= MAX_SESSION_MESSAGES) return fail(c, 422, 'SESSION_FULL', 'This chat has reached its message limit. Start a new chat.');

    const refused = isAdviceRequest(content);
    if (refused && deps.refusalAllowed && !(await deps.refusalAllowed(userId))) {
      return fail(c, 429, 'RATE_LIMITED', 'You are sending messages too fast. Wait a minute and try again.', { retryAfter: 60 });
    }
    let remaining: number | null = null;
    if (!refused) {
      const q = await c.get('quota').consume('ai_chat');
      if (!q.ok) return quotaFail(c, 'ai_chat', q);
      remaining = q.remaining;
    }
    // Reserve the user's message and the reply in the session counter atomically: two tabs cannot both pass the cap.
    if (!(await addMessages(deps.store, userId, sessionId, 2, MAX_SESSION_MESSAGES))) {
      if (!refused) await c.get('quota').consume('ai_chat', -1).catch(() => undefined);
      return fail(c, 422, 'SESSION_FULL', 'This chat has reached its message limit. Start a new chat.');
    }

    const userMsg: ChatMessage = { id: timeId(deps.now()), role: 'user', content, createdAt: deps.now().toISOString() };
    await putMessage(deps.store, userId, sessionId, userMsg);
    const prior = (await listMessages(deps.store, userId, sessionId, HISTORY_TURNS + 1, true)).filter((m) => m.id !== userMsg.id).slice(-HISTORY_TURNS);

    const encoder = new TextEncoder();
    let closed = false;
    // Aborted when the client goes away (Stop, closed tab), so the model call stops and is not paid for any further.
    const upstream = new AbortController();
    c.req.raw.signal.addEventListener('abort', () => upstream.abort(), { once: true });
    const body$ = new ReadableStream<Uint8Array>({
      async start(controller) {
        const send = (s: string) => {
          if (!closed) controller.enqueue(encoder.encode(s));
        };
        const ping = setInterval(() => send(ssePing), deps.pingMs);
        let answer = '';
        let usage = { promptTokens: 0, outputTokens: 0 };
        let model: string | undefined;
        let known = new Set<string>();
        let failed = false;
        let truncated = false;
        try {
          if (refused) {
            for (const part of sentences(ADVICE_REFUSAL)) {
              answer += part;
              send(sseFrame('token', { t: part }));
            }
          } else {
            const insight = session.insightId ? await getInsight(deps.store, userId, session.insightId) : null;
            const period = chatPeriod(insight, deps.now());
            const { loaded, rules } = await loadPeriod(deps, userId, period);
            truncated = loaded.truncated;
            const ctx = buildChatContext(content, loaded.trades, rules, insight, period, loaded.truncated);
            known = ctx.knownTradeIds;
            const turns: GeminiContent[] = [...prior.map<GeminiContent>((m) => ({ role: m.role === 'user' ? 'user' : 'model', parts: [{ text: m.content }] })), { role: 'user', parts: [{ text: content }] }];
            for await (const chunk of deps.stream({ system: `${CHAT_SYSTEM}\n\n${ctx.text}`, contents: turns, temperature: 0.3, maxOutputTokens: 700, signal: upstream.signal })) {
              if (chunk.type === 'text') {
                answer += chunk.text;
                send(sseFrame('token', { t: chunk.text }));
              } else {
                usage = chunk.usage;
                model = chunk.model;
              }
            }
          }
        } catch (e) {
          failed = true;
          logAiFailure('chat', e, { requestId: c.get('requestId'), userId });
          if (!answer) await c.get('quota').consume('ai_chat', -1).catch(() => undefined);
          send(sseFrame('error', { code: 'AI_UNAVAILABLE', message: answer ? 'The answer was cut off. Please ask again.' : 'The AI service is unavailable right now. You were not charged; try again shortly.' }));
        }
        // A reply with no text (blocked or empty) is a failure: the unit is given back and the client is told.
        if (!answer && !failed) {
          failed = true;
          await c.get('quota').consume('ai_chat', -1).catch(() => undefined);
          send(sseFrame('error', { code: 'AI_UNAVAILABLE', message: 'The AI service could not answer that. You were not charged; try again or rephrase.' }));
        }
        if (answer) {
          const assistant: ChatMessage = {
            id: timeId(deps.now()), role: 'assistant', content: answer, createdAt: deps.now().toISOString(), usage, disclaimer: DISCLAIMER,
            ...(model ? { model } : {}), tradeIds: citedTradeIds(answer, known),
          };
          await putMessage(deps.store, userId, sessionId, assistant).catch(() => undefined);
          await touchSession(deps.store, userId, sessionId, { updatedAt: deps.now().toISOString(), title: session.title || content.slice(0, TITLE_MAX) }).catch(() => undefined);
          if (!failed) send(sseFrame('done', { messageId: assistant.id, usage: { ...usage, remaining }, disclaimer: DISCLAIMER, tradeIds: assistant.tradeIds, ...(refused ? { refused: true } : {}), ...(truncated ? { truncated: true } : {}) }));
        }
        // No reply was stored: only the user's message counts.
        if (!answer) await addMessages(deps.store, userId, sessionId, -1).catch(() => undefined);
        clearInterval(ping);
        if (!closed) controller.close();
        closed = true;
      },
      cancel() {
        closed = true; // start() keeps running to persist what was generated; later sends are dropped
        upstream.abort();
      },
    });
    return new Response(body$, { status: 200, headers: SSE_HEADERS });
  });

  return app;
}
