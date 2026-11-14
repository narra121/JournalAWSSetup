import type { AiStore } from '../store';
import type { FindingHistory, FindingKey } from './types';

/** One finding in one ISO week of one scope (an account, or all accounts of a currency). */
export interface HistoryRow {
  /** Monday (YYYY-MM-DD) of the ISO week */
  weekStart: string;
  key: FindingKey;
  title: string;
  count: number;
  net: number;
  avgR: number | null;
  /** it was a costed finding of that week's review (not only counted) */
  shown: boolean;
}

const PREFIX = 'FINDING#';
const DAY_MS = 86_400_000;
/** Weeks read back: enough for "third week in a row" and the 12-week window of the review. */
export const HISTORY_WEEKS = 12;
const MAX_ROWS = 600;

const utc = (day: string) => Date.parse(`${day}T00:00:00Z`);
const dayStr = (ms: number) => new Date(ms).toISOString().slice(0, 10);
export const addDays = (day: string, n: number) => dayStr(utc(day) + n * DAY_MS);

export function isoWeekStart(day: string): string {
  const wd = new Date(utc(day)).getUTCDay();
  return addDays(day, -((wd + 6) % 7));
}

/** `YYYY-Www` of a day. */
export function isoWeek(day: string): string {
  const thursday = addDays(isoWeekStart(day), 3);
  const year = thursday.slice(0, 4);
  const week = Math.floor((utc(thursday) - utc(`${year}-01-01`)) / (7 * DAY_MS)) + 1;
  return `${year}-W${String(week).padStart(2, '0')}`;
}

export const historySk = (scope: string, weekStart: string, key: FindingKey) => `${PREFIX}${scope}#${weekStart}#${key}`;

/** Rows of the weeks before `weekStart` (newest first), at most HISTORY_WEEKS weeks back. */
export async function loadHistory(store: AiStore, userId: string, scope: string, weekStart: string): Promise<HistoryRow[]> {
  const oldest = addDays(weekStart, -7 * HISTORY_WEEKS);
  const rows: HistoryRow[] = [];
  let startKey: Record<string, unknown> | undefined;
  do {
    const r = await store.query(userId, { prefix: `${PREFIX}${scope}#`, limit: 200, newestFirst: true, startKey });
    for (const it of r.items) {
      const w = String(it.weekStart ?? '');
      if (w >= weekStart) continue;
      if (w < oldest) return rows;
      rows.push({ weekStart: w, key: String(it.key), title: String(it.title ?? it.key), count: Number(it.count) || 0, net: Number(it.net) || 0, avgR: typeof it.avgR === 'number' ? it.avgR : null, shown: it.shown === true });
    }
    startKey = r.lastKey;
  } while (startKey && rows.length < MAX_ROWS);
  return rows;
}

/** One row per key; a second review of the same week replaces that week's rows. */
export async function writeHistory(store: AiStore, userId: string, scope: string, weekStart: string, rows: Omit<HistoryRow, 'weekStart'>[], insightId: string): Promise<void> {
  const old = await store.query(userId, { prefix: `${PREFIX}${scope}#${weekStart}#`, limit: 500 });
  const keep = new Set(rows.map((r) => historySk(scope, weekStart, r.key)));
  const stale = old.items.map((i) => i.sk).filter((sk) => !keep.has(sk));
  if (stale.length) await store.delete(userId, stale);
  await Promise.all(rows.map((r) => store.put({ userId, sk: historySk(scope, weekStart, r.key), entity: 'finding-week', week: isoWeek(weekStart), weekStart, insightId, ...r })));
}

/** How the finding with `count` trades this week compares with the weeks before `weekStart`. */
export function historyOf(key: FindingKey, count: number, rows: HistoryRow[], weekStart: string): FindingHistory {
  const byWeek = new Map(rows.filter((r) => r.key === key).map((r) => [r.weekStart, r.count]));
  const last = byWeek.get(addDays(weekStart, -7));
  let weeksInRow = count > 0 ? 1 : 0;
  for (let w = addDays(weekStart, -7); count > 0 && (byWeek.get(w) ?? 0) > 0; w = addDays(w, -7)) weeksInRow++;
  const status = last == null || last === 0 ? 'new' : count < last ? 'down' : count > last ? 'up' : 'same';
  return { weeksInRow, lastWeekCount: last ?? null, status };
}

/** Last week's shown findings that have no trades this week. */
export function resolvedSince(rows: HistoryRow[], weekStart: string, countNow: (key: FindingKey) => number): { key: FindingKey; title: string; lastWeekCount: number }[] {
  const lastWeek = addDays(weekStart, -7);
  return rows.filter((r) => r.weekStart === lastWeek && r.shown && r.count > 0 && countNow(r.key) === 0).map((r) => ({ key: r.key, title: r.title, lastWeekCount: r.count }));
}
