import { describe, expect, it } from 'vitest';
import { parseCsv, sniffDelimiter } from '../csv';
import { htmlRows } from '../html';
import { findHeaderRow, cellGetter, num, parseLocalDateTime, toUtcIso, istDate } from '../table';
import { readXlsx, FileFormatError } from '../xlsx';
import { makeZip } from './zip';

const xlsxFiles = {
  'xl/workbook.xml': '<workbook xmlns:r="r"><sheets><sheet name="Trades &amp; P&amp;L" sheetId="1" r:id="rId1"/></sheets></workbook>',
  'xl/_rels/workbook.xml.rels': '<Relationships><Relationship Id="rId1" Type="ws" Target="worksheets/sheet1.xml"/></Relationships>',
  'xl/sharedStrings.xml': '<sst><si><t>Symbol</t></si><si><t>Date</t></si><si><r><t>Qty</t></r><r><t xml:space="preserve"> (units)</t></r></si><si><t>RELIANCE &amp; Co</t></si></sst>',
  'xl/styles.xml': '<styleSheet><numFmts><numFmt numFmtId="164" formatCode="dd/mm/yyyy hh:mm"/></numFmts><cellXfs><xf numFmtId="0"/><xf numFmtId="164"/><xf numFmtId="14"/></cellXfs></styleSheet>',
  'xl/worksheets/sheet1.xml':
    '<worksheet><sheetData><row r="1"/><row r="2"><c r="A2" t="s"><v>0</v></c><c r="B2" t="s"><v>1</v></c><c r="D2" t="s"><v>2</v></c></row>' +
    '<row r="3"><c r="A3" t="s"><v>3</v></c><c r="B3" s="1"><v>46115.388194444444</v></c><c r="D3"><v>12.5</v></c></row>' +
    '<row r="4"><c r="A4" t="inlineStr"><is><t>TCS</t></is></c><c r="B4" s="2"><v>46116</v></c><c r="C4" t="b"><v>1</v></c></row></sheetData></worksheet>',
};

describe('csv', () => {
  it('quotes, doubled quotes, embedded newline and comma, BOM, CRLF', () => {
    const rows = parseCsv('﻿a,b,c\r\n"x, y","he said ""hi""","multi\nline"\r\n\r\n1,2,3');
    expect(rows).toEqual([['a', 'b', 'c'], ['x, y', 'he said "hi"', 'multi\nline'], ['1', '2', '3']]);
  });
  it('a quote that never closes does not swallow the rest of the file (BE-107)', () => {
    const rows = parseCsv('a,b,c\n1,"stray note,3\n4,5,6\n7,8,9', ',');
    expect(rows).toEqual([['a', 'b', 'c'], ['1', '"stray note', '3'], ['4', '5', '6'], ['7', '8', '9']]);
  });
  it('quotes that do close are untouched even when a later one does not', () => {
    const rows = parseCsv('a,b\n"x,y",2\n3,"open\n4,5', ',');
    expect(rows).toEqual([['a', 'b'], ['x,y', '2'], ['3', '"open'], ['4', '5']]);
  });
  it('a hostile file of many stray quotes is read in linear time', () => {
    const t0 = performance.now();
    parseCsv('x,"'.repeat(200_000), ',');
    expect(performance.now() - t0).toBeLessThan(1500);
  });
  it('sniffs ; and tab delimiters', () => {
    expect(sniffDelimiter('a;b;c\n1;2,5;3')).toBe(';');
    expect(sniffDelimiter('a\tb\n1\t2')).toBe('\t');
  });
});

describe('xlsx', () => {
  it('reads shared/inline strings, rich text, dates by style, sparse columns, booleans', () => {
    const [sheet] = readXlsx(makeZip(xlsxFiles));
    expect(sheet.name).toBe('Trades & P&L');
    expect(sheet.rows[0]).toEqual(['Symbol', 'Date', '', 'Qty (units)']);
    expect(sheet.rows[1]).toEqual(['RELIANCE & Co', '2026-04-03 09:19:00', '', '12.5']);
    expect(sheet.rows[2]).toEqual(['TCS', '2026-04-04 00:00:00', 'TRUE']);
  });
  it('rejects non-zip input', () => {
    expect(() => readXlsx(Buffer.from('not a zip at all, definitely not'))).toThrow(FileFormatError);
  });
});

describe('html', () => {
  it('extracts rows, strips tags/entities, expands colspan', () => {
    const rows = htmlRows('<table><tr><td colspan=3><b>Closed Transactions:</b></td></tr><tr><td>1</td><td>2026.04.03&nbsp;10:00</td><td class=mspt>1&nbsp;234.50</td></tr><tr><td>&amp;x</td><td></td><td>y</td></tr></table>');
    expect(rows).toEqual([['Closed Transactions:', '', ''], ['1', '2026.04.03 10:00', '1 234.50'], ['&x', '', 'y']]);
  });
});

describe('table helpers', () => {
  it('finds header after preamble and reads by alias', () => {
    const rows = [['Client ID', 'AB1234'], [], ['Symbol', 'Trade Date', 'Qty.'], ['INFY', '2026-04-03', '10']];
    const m = findHeaderRow(rows.filter((r) => r.length), ['symbol', 'trade date'])!;
    expect(m.index).toBe(1);
    const get = cellGetter(m, ['INFY', '2026-04-03', '10']);
    expect(get('quantity', 'Qty.')).toBe('10');
  });
  it('parses Indian and MT number formats', () => {
    expect(num('1,23,456.50')).toBe(123456.5);
    expect(num('1 234.56')).toBe(1234.56);
    expect(num('(12.30)')).toBe(-12.3);
    expect(num('₹ 1,200')).toBe(1200);
    expect(num('-')).toBeNull();
    expect(num('12.5-')).toBe(-12.5);
    expect(num('abc')).toBeNull();
  });
  it('parses dates in broker formats and converts IST to UTC', () => {
    const cases: [string, string, string][] = [
      ['2026-04-03T09:20:33', '', '2026-04-03T03:50:33.000Z'],
      ['2026.04.03 09:20', '', '2026-04-03T03:50:00.000Z'],
      ['03-04-2026', '09:20:33', '2026-04-03T03:50:33.000Z'],
      ['03/04/2026 03:20:33 PM', '', '2026-04-03T09:50:33.000Z'],
      ['03-Apr-2026 12:05 AM', '', '2026-04-02T18:35:00.000Z'],
      ['Apr 03, 2026 09:20 AM', '', '2026-04-03T03:50:00.000Z'],
    ];
    for (const [d, t, want] of cases) expect(toUtcIso(parseLocalDateTime(d, t)!, 330)).toBe(want);
    expect(parseLocalDateTime('2026-13-01')).toBeNull();
    expect(istDate('2026-04-02T18:35:00.000Z')).toBe('2026-04-03');
  });
});
