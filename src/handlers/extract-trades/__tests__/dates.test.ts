import { describe, expect, it } from 'vitest';
import { decideOrder, isTimeZone, readCell, regionOrder, resolveCell, type DateOrder, type ReadContext } from '../dates';

const ctx: ReadContext = { now: new Date('2026-11-13T06:00:00Z'), timeZone: null };
const iso = (raw: string, order: DateOrder = 'DMY', c: ReadContext = ctx) => resolveCell(readCell(raw), order, c)?.iso ?? null;
const table = (cells: string[], c: ReadContext = ctx) => decideOrder(cells.map((x) => ({ open: null, close: readCell(x) })), c);

describe('readCell + resolveCell', () => {
  it('keeps seconds and milliseconds, and reads day first or month first only as told', () => {
    expect(iso('03/12/2025 08:41:09.075', 'DMY')).toBe('2025-12-03T08:41:09.075');
    expect(iso('03/12/2025 08:41:09.075', 'MDY')).toBe('2025-03-12T08:41:09.075');
    expect(iso('03/12/2025 08:41')).toBe('2025-12-03T08:41:00');
  });

  it('reads ISO, MT4 dots, dashes, compact and 2-digit years', () => {
    expect(iso('2025-12-03 08:41:09')).toBe('2025-12-03T08:41:09');
    expect(iso('2025-12-03T08:41:09', 'MDY')).toBe('2025-12-03T08:41:09');
    expect(iso('2025.12.03 08:41:09')).toBe('2025-12-03T08:41:09');
    expect(iso('03.12.2025 08:41')).toBe('2025-12-03T08:41:00');
    expect(iso('03-12-25 08:41')).toBe('2025-12-03T08:41:00');
    expect(iso('20251203 08:41:09')).toBe('2025-12-03T08:41:09');
  });

  it('reads month names in any position, with or without a weekday', () => {
    expect(iso('Dec 3, 2025 20:41:09', 'MDY')).toBe('2025-12-03T20:41:09');
    expect(iso('3 Dec 2025 20:41')).toBe('2025-12-03T20:41:00');
    expect(iso('03-Dec-25 09:15')).toBe('2025-12-03T09:15:00');
    expect(iso('Wed, 3 December 2025, 09:15:02')).toBe('2025-12-03T09:15:02');
    expect(iso('2025 Dec 03')).toBe('2025-12-03T00:00:00');
  });

  it('turns a 12-hour clock into 24 hours; midnight and noon included', () => {
    expect(iso('12/3/2025 8:41 PM', 'MDY')).toBe('2025-12-03T20:41:00');
    expect(iso('12/3/2025, 12:05:09 AM', 'MDY')).toBe('2025-12-03T00:05:09');
    expect(iso('12/3/2025 12:05 p.m.', 'MDY')).toBe('2025-12-03T12:05:00');
    expect(readCell('12/3/2025 13:05 PM')).toBeNull();
  });

  it('keeps a zone written in the cell', () => {
    expect(iso('2025-12-03T08:41:09.075Z')).toBe('2025-12-03T08:41:09.075Z');
    expect(iso('2025-12-03 08:41:09 UTC+5:30')).toBe('2025-12-03T08:41:09+05:30');
    expect(iso('2025-12-03 08:41:09 GMT')).toBe('2025-12-03T08:41:09Z');
  });

  it('fills a missing year so the date is not in the future: a table across New Year', () => {
    const jan = { now: new Date('2026-01-02T06:00:00Z'), timeZone: 'Asia/Kolkata' };
    expect(resolveCell(readCell('30/12 10:00'), 'DMY', jan)).toEqual({ iso: '2025-12-30T10:00:00', yearAssumed: true, dayAssumed: false });
    expect(iso('01/01 09:00', 'DMY', jan)).toBe('2026-01-01T09:00:00');
  });

  it('a time alone is today in the user zone, flagged', () => {
    const late = { now: new Date('2026-11-13T20:00:00Z'), timeZone: 'Asia/Kolkata' };
    expect(resolveCell(readCell('17:01'), 'DMY', late)).toEqual({ iso: '2026-11-14T17:01:00', yearAssumed: false, dayAssumed: true });
  });

  it('blank, dashes and impossible dates are not dates', () => {
    for (const raw of ['', '  ', '-', 'N/A', 'Buy', '31/02/2025 10:00', '2025-13-01']) expect(iso(raw)).toBeNull();
    expect(iso('13/05/2025', 'MDY')).toBeNull();
  });
});

describe('decideOrder', () => {
  it('a day above 12 decides day first (DD/MM)', () => {
    expect(table(['03/11/2025 10:00', '13/11/2025 10:00'])).toEqual({ dateOrder: 'DMY', dateOrderSource: 'evidence', canSwitch: false });
  });

  it('a second part above 12 decides month first (MM/DD)', () => {
    expect(table(['11/03/2025 10:00', '11/13/2025 10:00'])).toEqual({ dateOrder: 'MDY', dateOrderSource: 'evidence', canSwitch: false });
  });

  it('mixed evidence goes with the majority', () => {
    expect(table(['13/11/2025', '14/11/2025', '11/15/2025']).dateOrder).toBe('DMY');
  });

  it('a reading that puts a trade in the future loses', () => {
    expect(table(['12/11/2026 09:00'])).toMatchObject({ dateOrder: 'DMY', dateOrderSource: 'evidence', canSwitch: true });
  });

  it('a reading that closes a trade before it opened loses', () => {
    const d = decideOrder([{ open: readCell('01/02/2025 10:00'), close: readCell('02/01/2025 09:00') }], ctx);
    expect(d).toMatchObject({ dateOrder: 'MDY', dateOrderSource: 'evidence' });
  });

  it('rows in date order under only one reading decide it', () => {
    expect(table(['01/03/2025', '05/03/2025', '10/03/2025', '02/04/2025']).dateOrder).toBe('DMY');
    expect(table(['03/01/2025', '03/05/2025', '03/10/2025', '04/02/2025']).dateOrder).toBe('MDY');
  });

  it('ambiguous everywhere: the user region, then day first by default', () => {
    const cells = ['03/12/2025 08:41', '04/12/2025 10:44'];
    expect(table(cells, { ...ctx, timeZone: 'America/New_York' })).toEqual({ dateOrder: 'MDY', dateOrderSource: 'region', canSwitch: true });
    expect(table(cells, { ...ctx, timeZone: 'Asia/Kolkata' })).toEqual({ dateOrder: 'DMY', dateOrderSource: 'region', canSwitch: true });
    expect(table(cells)).toEqual({ dateOrder: 'DMY', dateOrderSource: 'default', canSwitch: true });
  });

  it('a table without day/month pairs needs no decision', () => {
    expect(table(['2025-12-03 08:41', 'Dec 4, 2025 10:00'])).toEqual({ dateOrder: 'YMD', dateOrderSource: 'evidence', canSwitch: false });
  });
});

describe('regionOrder / isTimeZone', () => {
  it('month first in the US and Canada, day first in the rest of the world, nothing for UTC', () => {
    expect(regionOrder('America/Chicago')).toBe('MDY');
    expect(regionOrder('America/Toronto')).toBe('MDY');
    expect(regionOrder('Pacific/Honolulu')).toBe('MDY');
    expect(regionOrder('America/Sao_Paulo')).toBe('DMY');
    expect(regionOrder('America/Argentina/Buenos_Aires')).toBe('DMY');
    for (const tz of ['Asia/Kolkata', 'Europe/London', 'Africa/Lagos', 'Australia/Sydney']) expect(regionOrder(tz)).toBe('DMY');
    expect(regionOrder('UTC')).toBeNull();
    expect(regionOrder(null)).toBeNull();
  });

  it('accepts only real zone names', () => {
    expect(isTimeZone('Asia/Kolkata')).toBe(true);
    expect(isTimeZone('Not/AZone')).toBe(false);
    expect(isTimeZone(5)).toBe(false);
  });
});
