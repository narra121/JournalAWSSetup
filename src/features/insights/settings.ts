import type { AiStore } from '../store';
import type { FindingKey } from './types';

export interface InsightSettings {
  /** send trade notes and lessons to the model for "From your notes" and the debrief note; off unless switched on */
  useNotes: boolean;
}

const SETTINGS_SK = 'SETTINGS#insights';
const MUTE_PREFIX = 'MUTE#';
const FEEDBACK_PREFIX = 'FEEDBACK#';
export const MUTE_DAYS = 30;

export async function getSettings(store: AiStore, userId: string): Promise<InsightSettings> {
  const it = await store.get(userId, SETTINGS_SK);
  return { useNotes: it?.useNotes === true };
}

export async function putSettings(store: AiStore, userId: string, s: InsightSettings, now: Date): Promise<void> {
  await store.put({ userId, sk: SETTINGS_SK, entity: 'insight-settings', useNotes: s.useNotes, updatedAt: now.toISOString() });
}

/** Keys muted until a time after `now`. */
export async function mutedKeys(store: AiStore, userId: string, now: Date): Promise<Set<FindingKey>> {
  const out = new Set<FindingKey>();
  let startKey: Record<string, unknown> | undefined;
  do {
    const r = await store.query(userId, { prefix: MUTE_PREFIX, limit: 200, startKey });
    for (const it of r.items) if (typeof it.until === 'string' && it.until > now.toISOString()) out.add(String(it.key));
    startKey = r.lastKey;
  } while (startKey);
  return out;
}

/** Records the answer; "not useful" mutes the key for MUTE_DAYS, "useful" lifts a mute. */
export async function recordFeedback(store: AiStore, userId: string, insightId: string, key: FindingKey, useful: boolean, now: Date): Promise<{ mutedUntil: string | null }> {
  await store.put({ userId, sk: `${FEEDBACK_PREFIX}${insightId}#${key}`, entity: 'insight-feedback', insightId, key, useful, at: now.toISOString() });
  if (useful) {
    await store.delete(userId, [`${MUTE_PREFIX}${key}`]);
    return { mutedUntil: null };
  }
  const until = new Date(now.getTime() + MUTE_DAYS * 86_400_000).toISOString();
  await store.put({ userId, sk: `${MUTE_PREFIX}${key}`, entity: 'insight-mute', key, until, insightId });
  return { mutedUntil: until };
}
