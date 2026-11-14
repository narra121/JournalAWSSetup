import type { AiStore } from '../store';
import { parseFocusRule } from './rules';
import type { Focus } from './types';

/** One active focus per user. */
export const FOCUS_SK = 'FOCUS#active';

export async function getFocus(store: AiStore, userId: string): Promise<Focus | null> {
  const it = await store.get(userId, FOCUS_SK);
  if (!it) return null;
  const rule = parseFocusRule(it.rule);
  if (typeof rule === 'string' || typeof it.text !== 'string' || typeof it.startedAt !== 'string') return null;
  return { rule, text: it.text, startedAt: it.startedAt, findingKey: typeof it.findingKey === 'string' ? it.findingKey : null };
}

export async function putFocus(store: AiStore, userId: string, focus: Focus): Promise<void> {
  await store.put({ userId, sk: FOCUS_SK, entity: 'focus', ...focus });
}

export async function deleteFocus(store: AiStore, userId: string): Promise<void> {
  await store.delete(userId, [FOCUS_SK]);
}
