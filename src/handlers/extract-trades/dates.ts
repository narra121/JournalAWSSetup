/**
 * Date/time cells copied verbatim from a trade table, read in code. The model never reorders day and month: the order
 * is decided per table from all its cells (decideOrder), then each cell is resolved with it (resolveCell).
 * The frontend twin is TradeFlow/src/lib/import/dates.ts (re-parses the same cells when the user switches the order).
 */

export type DateOrder = 'DMY' | 'MDY' | 'YMD';
export type DateOrderSource = 'evidence' | 'region' | 'default';

interface Clock {
  h: number;
  mi: number;
  s: number;
  /** fraction of a second as written ("075"), null when absent */
  frac: string | null;
}

export interface DateCell {
  /** 'pair' = two numbers whose day/month order is unknown (a/b); 'fixed' = order known (ISO, month name) */
  kind: 'pair' | 'fixed' | 'timeOnly';
  a: number;
  b: number;
  /** null = no year in the cell */
  y: number | null;
  time: Clock | null;
  /** 'Z' or '+05:30'; null = wall clock without a zone */
  zone: string | null;
}

export interface ReadContext {
  now: Date;
  /** IANA zone of the user: today's date for cells without a year or date, and the region fallback */
  timeZone?: string | null;
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const MONTH_RE = /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?/i;
const WEEKDAY_RE = /\b(mon|tue|wed|thu|fri|sat|sun)[a-z]*\.?,?/gi;
const TIME_RE =
  /(?:^|[\sT,;@])(\d{1,2}):(\d{2})(?::(\d{2})(?:[.,](\d{1,9}))?)?(?:\s*([ap])\.?\s*m\.?)?(?:\s*(z|(?:utc|gmt)(?:\s*[+-]\d{1,2}(?::?\d{2})?)?|[+-]\d{2}:?\d{2}))?(?=$|[\s,;)])/i;

const pad = (n: number, w = 2) => String(n).padStart(w, '0');

function zoneOf(text: string | undefined): string | null {
  if (!text) return null;
  const t = text.replace(/\s+/g, '').toUpperCase();
  if (t === 'Z' || t === 'UTC' || t === 'GMT') return 'Z';
  const m = /^(?:UTC|GMT)?([+-])(\d{1,2}):?(\d{2})?$/.exec(t);
  if (!m) return null;
  const mins = Number(m[2]) * 60 + Number(m[3] ?? 0);
  return mins === 0 ? 'Z' : `${m[1]}${pad(Number(m[2]))}:${pad(Number(m[3] ?? 0))}`;
}

const realDay = (y: number, mo: number, d: number) => {
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return false;
  const t = new Date(Date.UTC(y, mo - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === mo - 1 && t.getUTCDate() === d;
};

const fullYear = (digits: string) => (digits.length === 2 ? 2000 + Number(digits) : Number(digits));

/** Splits one cell into its date numbers and clock; null when it is blank or not a date. */
export function readCell(raw: string | null | undefined): DateCell | null {
  let rest = String(raw ?? '').trim();
  if (!rest || /^(-|—|n\/?a|none|null)$/i.test(rest)) return null;

  let time: Clock | null = null;
  let zone: string | null = null;
  const tm = TIME_RE.exec(rest);
  if (tm) {
    let h = Number(tm[1]);
    const mi = Number(tm[2]);
    const s = Number(tm[3] ?? 0);
    const ampm = tm[5]?.toLowerCase();
    if (ampm) {
      if (h < 1 || h > 12) return null;
      h = (h % 12) + (ampm === 'p' ? 12 : 0);
    }
    if (h > 23 || mi > 59 || s > 59) return null;
    time = { h, mi, s, frac: tm[4] ?? null };
    zone = zoneOf(tm[6]);
    rest = (rest.slice(0, tm.index) + ' ' + rest.slice(tm.index + tm[0].length)).trim();
  }

  rest = rest.replace(WEEKDAY_RE, ' ').replace(/\bat\b/gi, ' ').replace(/[,;]+/g, ' ').replace(/\s+/g, ' ').trim();
  rest = rest.replace(/^[^0-9a-z]+|[^0-9a-z.]+$/gi, '').replace(/\.$/, '');
  if (!rest) return time ? { kind: 'timeOnly', a: 0, b: 0, y: null, time, zone } : null;

  const month = MONTH_RE.exec(rest);
  if (month) {
    const mo = MONTHS.indexOf(month[1].toLowerCase()) + 1;
    const nums = (rest.slice(0, month.index) + ' ' + rest.slice(month.index + month[0].length)).match(/\d+/g) ?? [];
    let y: number | null = null;
    let d: number | undefined;
    const four = nums.findIndex((n) => n.length === 4);
    if (four >= 0) {
      y = Number(nums[four]);
      d = Number(nums.find((_, i) => i !== four));
    } else if (nums.length >= 2) {
      d = Number(nums[0]);
      y = fullYear(nums[1]);
    } else if (nums.length === 1) d = Number(nums[0]);
    if (!d || !realDay(y ?? 2000, mo, d)) return null;
    return { kind: 'fixed', a: d, b: mo, y, time, zone };
  }

  if (/^\d{8}$/.test(rest)) {
    const y = Number(rest.slice(0, 4));
    const mo = Number(rest.slice(4, 6));
    const d = Number(rest.slice(6, 8));
    return realDay(y, mo, d) ? { kind: 'fixed', a: d, b: mo, y, time, zone } : null;
  }

  const groups = rest.split(/\s*[-/.\s]\s*/).filter(Boolean);
  if (!groups.every((g) => /^\d+$/.test(g))) return null;
  if (groups.length === 3 && groups[0].length === 4) {
    const [y, mo, d] = groups.map(Number);
    return realDay(y, mo, d) ? { kind: 'fixed', a: d, b: mo, y, time, zone } : null;
  }
  if (groups.length === 3 && groups[0].length <= 2 && groups[1].length <= 2 && (groups[2].length === 4 || groups[2].length === 2)) {
    return { kind: 'pair', a: Number(groups[0]), b: Number(groups[1]), y: fullYear(groups[2]), time, zone };
  }
  if (groups.length === 2 && groups[0].length <= 2 && groups[1].length <= 2) {
    return { kind: 'pair', a: Number(groups[0]), b: Number(groups[1]), y: null, time, zone };
  }
  return null;
}

/** Calendar date of an instant in `tz` (UTC when unset or unknown). */
function todayIn(now: Date, tz?: string | null): { y: number; mo: number; d: number } {
  try {
    if (tz) {
      const p = Object.fromEntries(
        new Intl.DateTimeFormat('en-US', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now).map((x) => [x.type, x.value]),
      );
      return { y: Number(p.year), mo: Number(p.month), d: Number(p.day) };
    }
  } catch {
    /* unknown zone: UTC below */
  }
  return { y: now.getUTCFullYear(), mo: now.getUTCMonth() + 1, d: now.getUTCDate() };
}

const dayNumber = (y: number, mo: number, d: number) => Date.UTC(y, mo - 1, d) / 86_400_000;

export interface ResolvedDate {
  /** `YYYY-MM-DDTHH:MM:SS[.fff][zone]`; no zone = wall clock of the platform */
  iso: string;
  yearAssumed: boolean;
  dayAssumed: boolean;
}

/** One cell as an ISO date-time under `order`; null when the cell is not a real date in that order. */
export function resolveCell(cell: DateCell | null, order: DateOrder, ctx: ReadContext): ResolvedDate | null {
  if (!cell) return null;
  const today = todayIn(ctx.now, ctx.timeZone);
  let y: number;
  let mo: number;
  let d: number;
  let yearAssumed = false;
  let dayAssumed = false;
  if (cell.kind === 'timeOnly') {
    ({ y, mo, d } = today);
    dayAssumed = true;
  } else {
    [d, mo] = cell.kind === 'pair' && order === 'MDY' ? [cell.b, cell.a] : [cell.a, cell.b];
    if (cell.y === null) {
      // Trades are in the past: a day-month later than tomorrow belongs to last year (a table spanning New Year).
      y = today.y;
      if (realDay(y, mo, d) && dayNumber(y, mo, d) > dayNumber(today.y, today.mo, today.d) + 1) y -= 1;
      yearAssumed = true;
    } else y = cell.y;
    if (!realDay(y, mo, d)) return null;
  }
  const t = cell.time ?? { h: 0, mi: 0, s: 0, frac: null };
  const frac = t.frac ? `.${t.frac.padEnd(3, '0').slice(0, 3)}` : '';
  return { iso: `${pad(y, 4)}-${pad(mo)}-${pad(d)}T${pad(t.h)}:${pad(t.mi)}:${pad(t.s)}${frac}${cell.zone ?? ''}`, yearAssumed, dayAssumed };
}

const LATIN_AMERICA =
  /^America\/(Argentina\/|Buenos_Aires|Cordoba|Sao_Paulo|Bahia|Fortaleza|Recife|Belem|Maceio|Manaus|Cuiaba|Campo_Grande|Porto_Velho|Boa_Vista|Rio_Branco|Araguaina|Santarem|Noronha|Bogota|Lima|Santiago|Punta_Arenas|Caracas|Montevideo|Asuncion|La_Paz|Guayaquil|Mexico_City|Monterrey|Merida|Cancun|Chihuahua|Hermosillo|Mazatlan|Tijuana|Matamoros|Bahia_Banderas|Guatemala|El_Salvador|Tegucigalpa|Managua|Costa_Rica|Havana|Santo_Domingo)/;

/** Day/month order people in `tz` write: month first in the US and Canada, day first elsewhere; null for UTC or unknown. */
export function regionOrder(tz?: string | null): 'DMY' | 'MDY' | null {
  if (!tz) return null;
  if (tz.startsWith('America/')) return LATIN_AMERICA.test(tz) ? 'DMY' : 'MDY';
  if (/^(US|Canada)\//.test(tz) || tz === 'Pacific/Honolulu') return 'MDY';
  if (/^(Asia|Europe|Africa|Australia|Indian|Atlantic|Pacific|Antarctica)\//.test(tz)) return 'DMY';
  return null;
}

export interface OrderDecision {
  dateOrder: DateOrder;
  dateOrderSource: DateOrderSource;
  /** every day/month cell is also a real date the other way round, so the review offers the switch */
  canSwitch: boolean;
}

const monotonic = (xs: string[]) => {
  const keys = xs.map((x) => x.slice(0, 23));
  return keys.every((k, i) => i === 0 || k >= keys[i - 1]) || keys.every((k, i) => i === 0 || k <= keys[i - 1]);
};

/**
 * Day/month order of one table. Evidence first: a number above 12 in either place, then (when both orders read every
 * cell) a date in the future, an open after its close, or rows out of date order under only one of the two. Then the
 * user's region; then day first, the order of the app's default zone (Asia/Kolkata).
 */
export function decideOrder(rows: { open: DateCell | null; close: DateCell | null }[], ctx: ReadContext): OrderDecision {
  const cells = rows.flatMap((r) => [r.open, r.close]).filter((c): c is DateCell => !!c);
  const pairs = cells.filter((c) => c.kind === 'pair');
  if (pairs.length === 0) return { dateOrder: 'YMD', dateOrderSource: 'evidence', canSwitch: false };

  let dmy = 0;
  let mdy = 0;
  for (const p of pairs) {
    if (p.a > 12 && p.b <= 12) dmy += 1;
    else if (p.b > 12 && p.a <= 12) mdy += 1;
  }
  if (dmy > 0 || mdy > 0) return { dateOrder: dmy >= mdy ? 'DMY' : 'MDY', dateOrderSource: 'evidence', canSwitch: false };

  const judge = (order: 'DMY' | 'MDY') => {
    const read = (c: DateCell | null) => resolveCell(c, order, ctx)?.iso ?? null;
    const today = todayIn(ctx.now, ctx.timeZone);
    const tomorrow = new Date(Date.UTC(today.y, today.mo - 1, today.d + 2)).toISOString().slice(0, 10);
    const future = pairs.some((c) => c.y !== null && (read(c) ?? '') >= tomorrow);
    const backwards = rows.some((r) => {
      const o = read(r.open);
      const c = read(r.close);
      return !!o && !!c && o.slice(0, 23) > c.slice(0, 23);
    });
    const column = (pick: (r: (typeof rows)[number]) => DateCell | null) =>
      rows.map(pick).filter((c) => c?.kind === 'pair').map((c) => read(c)).filter((x): x is string => !!x);
    const ordered = monotonic(column((r) => r.close)) && monotonic(column((r) => r.open));
    return { future, backwards, ordered };
  };
  const D = judge('DMY');
  const M = judge('MDY');
  for (const key of ['future', 'backwards'] as const) {
    if (D[key] !== M[key]) return { dateOrder: D[key] ? 'MDY' : 'DMY', dateOrderSource: 'evidence', canSwitch: true };
  }
  if (D.ordered !== M.ordered) return { dateOrder: D.ordered ? 'DMY' : 'MDY', dateOrderSource: 'evidence', canSwitch: true };

  const region = regionOrder(ctx.timeZone);
  if (region) return { dateOrder: region, dateOrderSource: 'region', canSwitch: true };
  return { dateOrder: 'DMY', dateOrderSource: 'default', canSwitch: true };
}

/** True when `tz` is an IANA zone this runtime knows. */
export function isTimeZone(tz: unknown): tz is string {
  if (typeof tz !== 'string' || !tz || tz.length > 64) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}
