import { GetCommand } from '@aws-sdk/lib-dynamodb';
import { ddb } from './dynamo';

/** True for the values that mean "no conversion": unset, UTC, GMT. */
const isUtc = (tz?: string | null): boolean => !tz || tz === 'UTC' || tz === 'Etc/UTC' || tz === 'GMT';

const formatters = new Map<string, Intl.DateTimeFormat>();
function parts(tz: string): Intl.DateTimeFormat {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
    formatters.set(tz, f);
  }
  return f;
}

function wall(ms: number, tz: string): { y: number; mo: number; d: number; h: number } {
  const p = Object.fromEntries(parts(tz).formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return { y: Number(p.year), mo: Number(p.month), d: Number(p.day), h: Number(p.hour) % 24 };
}

const pad = (n: number) => String(n).padStart(2, '0');

/**
 * Calendar day (YYYY-MM-DD) of an instant in `tz`. A date-only value (no time part) is already a calendar day and is
 * returned as is; so is any value in UTC / no time zone.
 */
export function dayOf(openDate: string, tz?: string | null): string {
  if (!openDate) return '';
  if (!openDate.includes('T') || isUtc(tz)) return openDate.split('T')[0];
  const ms = Date.parse(openDate);
  if (Number.isNaN(ms)) return openDate.split('T')[0];
  const w = wall(ms, tz!);
  return `${w.y}-${pad(w.mo)}-${pad(w.d)}`;
}

/** Hour of day (0-23) of an instant in `tz`; null for date-only or unparsable values. */
export function hourOf(openDate: string, tz?: string | null): number | null {
  if (!openDate || !openDate.includes('T')) return null;
  const ms = Date.parse(openDate);
  if (Number.isNaN(ms)) return null;
  return isUtc(tz) ? new Date(ms).getUTCHours() : wall(ms, tz!).h;
}

/** Weekday (0 = Sunday) of a calendar day string. */
export const weekdayOf = (date: string): number => new Date(`${date}T00:00:00Z`).getUTCDay();

/** Offset of `tz` from UTC at an instant, in ms (local wall clock minus UTC). */
function offsetMs(ms: number, tz: string): number {
  const p = Object.fromEntries(parts(tz).formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  const asUtc = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour) % 24, Number(p.minute), Number(p.second));
  return asUtc - Math.floor(ms / 1000) * 1000;
}

/**
 * ISO bounds [start, end] (UTC, inclusive end at .999) of a calendar day in `tz`, for querying the openDate index.
 * Daylight-saving days are 23 or 25 hours long.
 */
export function dayRangeUtc(date: string, tz?: string | null): { start: string; end: string } {
  if (isUtc(tz)) return { start: `${date}`, end: `${date}T23:59:59.999Z` };
  const midnightUtc = Date.parse(`${date}T00:00:00Z`);
  const guess = midnightUtc - offsetMs(midnightUtc, tz!);
  const start = midnightUtc - offsetMs(guess, tz!);
  const nextDate = new Date(midnightUtc + 86400000).toISOString().slice(0, 10);
  const nextMidnightUtc = Date.parse(`${nextDate}T00:00:00Z`);
  const nextGuess = nextMidnightUtc - offsetMs(nextMidnightUtc, tz!);
  const nextStart = nextMidnightUtc - offsetMs(nextGuess, tz!);
  return { start: new Date(start).toISOString(), end: new Date(nextStart - 1).toISOString() };
}

/** The user's `timeZone` preference (IANA name) or null when none is set. */
export async function getUserTimeZone(userId: string): Promise<string | null> {
  const table = process.env.USER_PREFERENCES_TABLE;
  if (!table) return null;
  const res = await ddb.send(new GetCommand({ TableName: table, Key: { userId }, ProjectionExpression: '#tz', ExpressionAttributeNames: { '#tz': 'timeZone' } }));
  const tz = res.Item?.timeZone;
  return typeof tz === 'string' && tz ? tz : null;
}
