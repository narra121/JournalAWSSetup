import type { QueryResult } from '../analysis/types';
import { INSIGHT_ID } from '../insights/store';
import type { AiItem, AiStore } from '../store';

export interface ChatSession {
  id: string;
  title: string;
  insightId?: string;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  createdAt: string;
  usage?: { promptTokens: number; outputTokens: number };
  disclaimer?: string;
  model?: string;
  tradeIds?: string[];
  /** tool results the app draws under the answer (absent on older messages and on answers without tools) */
  tables?: QueryResult[];
  /** currency of the amounts in `tables`; null when unknown */
  currency?: string | null;
}

export const SESSION_ID = INSIGHT_ID;
export const MAX_SESSION_MESSAGES = 100;
const sessionSk = (id: string) => `CHAT#${id}`;
const msgPrefix = (sessionId: string) => `MSG#${sessionId}#`;

const strip = <T>(it: AiItem): T => {
  const { userId: _u, sk: _s, entity: _e, ...rest } = it;
  return rest as unknown as T;
};

export async function putSession(store: AiStore, userId: string, s: ChatSession) {
  await store.put({ userId, sk: sessionSk(s.id), entity: 'chat-session', ...s });
}

/** Updates `updatedAt` (and the title) of a session without touching its message counter. */
export async function touchSession(store: AiStore, userId: string, id: string, set: { updatedAt: string; title?: string }) {
  await store.patch(userId, sessionSk(id), set);
}

/** Adds `by` messages to the session's counter; with `below`, only while it is under that cap (atomic, so two tabs cannot both pass it). */
export function addMessages(store: AiStore, userId: string, id: string, by: number, below?: number): Promise<boolean> {
  return store.addToCount(userId, sessionSk(id), 'messageCount', by, below);
}

export async function getSession(store: AiStore, userId: string, id: string): Promise<ChatSession | null> {
  const it = SESSION_ID.test(id) ? await store.get(userId, sessionSk(id)) : null;
  return it ? strip<ChatSession>(it) : null;
}

export async function listSessions(store: AiStore, userId: string, limit = 50): Promise<ChatSession[]> {
  const r = await store.query(userId, { prefix: 'CHAT#', limit, newestFirst: true });
  return r.items.map((i) => strip<ChatSession>(i));
}

export async function putMessage(store: AiStore, userId: string, sessionId: string, m: ChatMessage) {
  await store.put({ userId, sk: `${msgPrefix(sessionId)}${m.id}`, entity: 'chat-message', ...m });
}

export async function listMessages(store: AiStore, userId: string, sessionId: string, limit = 200, newestFirst = false): Promise<ChatMessage[]> {
  const r = await store.query(userId, { prefix: msgPrefix(sessionId), limit, newestFirst });
  const msgs = r.items.map((i) => strip<ChatMessage>(i));
  return newestFirst ? msgs.reverse() : msgs;
}

export async function deleteSession(store: AiStore, userId: string, sessionId: string) {
  let startKey: Record<string, unknown> | undefined;
  const sks: string[] = [];
  do {
    const r = await store.query(userId, { prefix: msgPrefix(sessionId), limit: 200, startKey });
    sks.push(...r.items.map((i) => i.sk));
    startKey = r.lastKey;
  } while (startKey);
  await store.delete(userId, [...sks, sessionSk(sessionId)]);
}
