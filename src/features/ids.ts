import { randomBytes } from 'node:crypto';

let lastMs = 0;

/**
 * Sortable id `<yyyyMMddTHHmmssSSSZ>_<8 hex>`: lexicographic order is creation order, so an AiData sort key derives
 * from it. The millisecond part never repeats within a process, so a user message and its reply keep their order.
 */
export function timeId(now: Date = new Date()): string {
  const ms = Math.max(now.getTime(), lastMs + 1);
  lastMs = ms;
  return `${new Date(ms).toISOString().replace(/[-:.]/g, '')}_${randomBytes(4).toString('hex')}`;
}
