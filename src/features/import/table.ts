import type { Row } from './csv';

export const normHeader = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

export interface HeaderMatch {
  index: number;
  /** normalised header name → column index (first occurrence) */
  col: Map<string, number>;
  headers: string[];
}

/**
 * First row (within the first `scanRows`) containing every `required` header (normalised). Preamble rows
 * such as client id or date range are skipped this way.
 */
export function findHeaderRow(rows: Row[], required: string[], scanRows = 60): HeaderMatch | null {
  const req = required.map(normHeader);
  for (let i = 0; i < Math.min(rows.length, scanRows); i++) {
    const normed = rows[i].map(normHeader);
    if (req.every((r) => normed.includes(r))) {
      const col = new Map<string, number>();
      normed.forEach((h, j) => {
        if (h && !col.has(h)) col.set(h, j);
      });
      return { index: i, col, headers: rows[i] };
    }
  }
  return null;
}

/** Accessor for one data row by normalised header (first match among aliases). */
export function cellGetter(m: HeaderMatch, row: Row) {
  return (...aliases: string[]): string => {
    for (const a of aliases) {
      const j = m.col.get(normHeader(a));
      if (j != null && row[j] != null && row[j] !== '') return row[j];
    }
    return '';
  };
}

/**
 * Parses numbers as brokers print them: "1,23,456.50", "1 234.56", "(12.30)" negative, "₹ 1,200", "-",
 * trailing "%". Empty / "-" → null.
 */
export function num(v: string | number | null | undefined): number | null {
  if (v == null) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  let s = v.trim();
  if (!s || s === '-' || s === '--') return null;
  let neg = false;
  if (/^\(.*\)$/.test(s)) {
    neg = true;
    s = s.slice(1, -1);
  }
  s = s.replace(/[₹$€£%\s]|INR|USD|Rs\.?/gi, '').replace(/,/g, '');
  if (s.endsWith('-')) {
    neg = !neg;
    s = s.slice(0, -1);
  }
  if (!/^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i.test(s)) return null;
  const n = Number(s);
  return Number.isFinite(n) ? (neg ? -n : n) : null;
}

const MONTHS: Record<string, number> = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12 };

export interface LocalDateTime {
  y: number;
  mo: number;
  d: number;
  h: number;
  mi: number;
  s: number;
}

/**
 * Wall-clock date/time in the formats Indian brokers and MetaTrader use (no zone):
 * 2026-04-03, 2026-04-03T09:20:33, 2026-04-03 09:20:33, 2026.04.03 09:20, 03-04-2026, 03/04/2026 (day first),
 * 03-Apr-2026, 03 Apr 2026, "Apr 03, 2026 09:20 AM", with optional AM/PM. `time` may be given separately.
 */
export function parseLocalDateTime(date: string, time = ''): LocalDateTime | null {
  const s = `${date} ${time}`.trim().replace(/\s+/g, ' ');
  let y: number, mo: number, d: number;
  let rest = '';
  let m: RegExpExecArray | null;
  if ((m = /^(\d{4})[-./](\d{1,2})[-./](\d{1,2})[T ]?(.*)$/.exec(s))) {
    y = +m[1]; mo = +m[2]; d = +m[3]; rest = m[4];
  } else if ((m = /^(\d{1,2})[-./](\d{1,2})[-./](\d{4})[T ]?(.*)$/.exec(s))) {
    d = +m[1]; mo = +m[2]; y = +m[3]; rest = m[4];
  } else if ((m = /^(\d{1,2})[- ]([A-Za-z]{3,4})[a-z]*[- ,]+(\d{2,4})[T ]?(.*)$/.exec(s))) {
    d = +m[1]; mo = MONTHS[m[2].toLowerCase()] ?? 0; y = +m[3] < 100 ? 2000 + +m[3] : +m[3]; rest = m[4];
  } else if ((m = /^([A-Za-z]{3,4})[a-z]* (\d{1,2}),? (\d{4})[T ]?(.*)$/.exec(s))) {
    mo = MONTHS[m[1].toLowerCase()] ?? 0; d = +m[2]; y = +m[3]; rest = m[4];
  } else return null;
  if (!(mo >= 1 && mo <= 12 && d >= 1 && d <= 31 && y >= 1990 && y <= 2100)) return null;
  let h = 0, mi = 0, sec = 0;
  const t = /(\d{1,2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?\s*([AaPp][Mm])?/.exec(rest);
  if (t) {
    h = +t[1]; mi = +t[2]; sec = t[3] ? +t[3] : 0;
    const ap = t[4]?.toLowerCase();
    if (ap === 'pm' && h < 12) h += 12;
    if (ap === 'am' && h === 12) h = 0;
  }
  if (h > 23 || mi > 59 || sec > 59) return null;
  return { y, mo, d, h, mi, s: sec };
}

export const IST_OFFSET_MINUTES = 330;

/** Wall-clock time at `offsetMinutes` east of UTC → UTC ISO string ('…Z'). */
export function toUtcIso(t: LocalDateTime, offsetMinutes: number): string {
  const ms = Date.UTC(t.y, t.mo - 1, t.d, t.h, t.mi, t.s) - offsetMinutes * 60000;
  return new Date(ms).toISOString();
}

/** IST calendar date (YYYY-MM-DD) of a UTC ISO instant. */
export function istDate(iso: string): string {
  return new Date(Date.parse(iso) + IST_OFFSET_MINUTES * 60000).toISOString().slice(0, 10);
}
