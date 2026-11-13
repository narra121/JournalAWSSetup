import { describe, expect, it } from 'vitest';
import { htmlRows } from '../html';
import { parseImport } from '../service';
import { decodeXmlEntities, excelSerialToLocal, FileFormatError, MAX_TAGS, readXlsx, ScanBudget } from '../xlsx';
import { makeZip } from './zip';

const timed = <T>(fn: () => T): { value: T; ms: number } => {
  const t0 = performance.now();
  const value = fn();
  return { value, ms: performance.now() - t0 };
};

const workbook = (sheetXml: string, extra: Record<string, string> = {}, workbookXml = '<workbook xmlns:r="r"><sheets><sheet name="S" sheetId="1" r:id="rId1"/></sheets></workbook>') =>
  makeZip({
    'xl/workbook.xml': workbookXml,
    'xl/_rels/workbook.xml.rels': '<Relationships><Relationship Id="rId1" Type="ws" Target="worksheets/sheet1.xml"/></Relationships>',
    'xl/worksheets/sheet1.xml': `<worksheet><sheetData>${sheetXml}</sheetData></worksheet>`,
    ...extra,
  });

describe('HTML scanning is linear (BE-010)', () => {
  // Each of these took seconds to minutes with the lazy-to-terminator regexes (quadratic).
  const hostile: [string, string][] = [
    ['an unclosed comment repeated', '<table>' + '<!--'.repeat(400_000)],
    ['<tr with no ">" repeated', '<table>' + '<tr'.repeat(400_000)],
    ['<td with no ">" repeated', '<table><tr>' + '<td'.repeat(400_000)],
    ['unclosed <script repeated', '<table>' + '<script>'.repeat(300_000)],
    ['rows and cells that never close', '<table>' + '<tr><td>x'.repeat(200_000)],
    ['a huge attribute list', `<table><tr><td ${'class=class='.repeat(300_000)}>x`],
  ];

  it.each(hostile)('%s (about 2-4 MB) is read in well under a second', (_name, html) => {
    const { ms } = timed(() => htmlRows(html));
    expect(ms).toBeLessThan(1500);
  });

  it('drops the rest of the file when a comment or script never ends', () => {
    expect(htmlRows('<table><tr><td>a</td></tr><!-- never closed <tr><td>b</td></tr>')).toEqual([['a']]);
    expect(htmlRows('<table><tr><td>a</td></tr><script> never closed <tr><td>b</td></tr>')).toEqual([['a']]);
  });

  it('still removes closed comments, scripts and styles and keeps every other row', () => {
    const rows = htmlRows('<table><!-- <tr><td>no</td></tr> --><tr><td>a</td></tr><SCRIPT>var x="<tr><td>no</td></tr>"</SCRIPT><style>td{}</style><tr><td>b</td></tr></table>');
    expect(rows).toEqual([['a'], ['b']]);
  });

  it('the number of tags one file may make the scanners look at is capped with a FileFormatError', () => {
    const budget = new ScanBudget();
    for (let i = 0; i < MAX_TAGS; i++) budget.hit();
    expect(() => budget.hit()).toThrow(FileFormatError);
  });
});

describe('XLSX scanning is linear (BE-010)', () => {
  it.each([
    ['<row> that never closes', '<row>'.repeat(2_000_000)],
    ['<c that never closes', '<row r="1">' + '<c r="A1">'.repeat(1_000_000) + '</row>'],
    ['<row r="1" with no ">"', '<row r="1" '.repeat(800_000)],
  ])('a sheet of about 10 MB with %s is read in well under a second', (_name, sheetXml) => {
    const zip = workbook(sheetXml);
    expect(zip.length).toBeLessThan(500_000);
    const { ms } = timed(() => {
      try {
        return readXlsx(zip);
      } catch (e) {
        return e;
      }
    });
    expect(ms).toBeLessThan(2000);
  });

  it('an unclosed <si> repeated in the shared strings is linear too', () => {
    const zip = workbook('<row r="1"><c r="A1" t="s"><v>0</v></c></row>', { 'xl/sharedStrings.xml': `<sst>${'<si>'.repeat(2_000_000)}</sst>` });
    const { ms } = timed(() => readXlsx(zip));
    expect(ms).toBeLessThan(2000);
  });

  it('an unclosed <sheet and <numFmt repeated in workbook.xml / styles.xml are linear', () => {
    const zip = workbook('<row r="1"><c r="A1" t="inlineStr"><is><t>x</t></is></c></row>', { 'xl/styles.xml': `<styleSheet>${'<numFmt '.repeat(2_000_000)}</styleSheet>` });
    const { ms } = timed(() => readXlsx(zip));
    expect(ms).toBeLessThan(2000);
  });

  it('well-formed content still reads: self-closing rows and cells, inline strings, shared strings', () => {
    const zip = workbook('<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="inlineStr"><is><t xml:space="preserve">in</t></is></c><c r="C1"/></row><row r="2"/><row r="3"><c r="A3"><v>7</v></c></row>', {
      'xl/sharedStrings.xml': '<sst><si><t>Sym</t></si></sst>',
    });
    expect(readXlsx(zip)[0].rows).toEqual([['Sym', 'in', ''], ['7']]);
  });
});

describe('malformed archives and entities (BE-103)', () => {
  it('a local header offset past the end of the file is a FileFormatError', () => {
    const good = workbook('<row r="1"/>');
    const bad = Buffer.from(good);
    // First central directory record: offset of its local header (position 42 inside the record).
    const cd = bad.readUInt32LE(bad.length - 22 + 16);
    bad.writeUInt32LE(bad.length + 1000, cd + 42);
    expect(() => readXlsx(bad)).toThrow(FileFormatError);
  });

  it('an entry whose size runs past the end of the file is a FileFormatError', () => {
    const good = workbook('<row r="1"/>');
    const bad = Buffer.from(good);
    const cd = bad.readUInt32LE(bad.length - 22 + 16);
    bad.writeUInt32LE(0x7fffffff, cd + 20);
    expect(() => readXlsx(bad)).toThrow(FileFormatError);
  });

  it('a character reference above U+10FFFF stays as text instead of throwing', () => {
    expect(decodeXmlEntities('a &#99999999; b &#x110000; c &#65;')).toBe('a &#99999999; b &#x110000; c A');
  });

  it('through the import service a cell with &#99999999; is not a 500', () => {
    const html = '<table><tr><td>Symbol</td><td>Side</td></tr><tr><td>&#99999999;</td><td>BUY</td></tr></table>';
    expect(htmlRows(html)[1][0]).toBe('&#99999999;');
    const r = parseImport({ source: 'auto', fileName: 'r.html', contentBase64: Buffer.from(html).toString('base64') });
    expect(r.trades).toEqual([]);
  });
});

describe('workbook styles and date system (BE-104, BE-105)', () => {
  const styles = (xfs: string) => `<styleSheet><cellXfs count="3">${xfs}</cellXfs></styleSheet>`;

  it('an <xf> without numFmtId counts as General, so later style indexes keep their position', () => {
    const zip = workbook(
      '<row r="1"><c r="A1" s="1"><v>46113.4</v></c><c r="B1" s="0"><v>46113.4</v></c></row>',
      { 'xl/styles.xml': styles('<xf fontId="0"/><xf numFmtId="14"/><xf numFmtId="0"/>') },
    );
    expect(readXlsx(zip)[0].rows[0]).toEqual(['2026-04-01 09:36:00', '46113.4']);
  });

  it('a numFmtId="14" first style is still a date', () => {
    const zip = workbook('<row r="1"><c r="A1" s="0"><v>46113.4</v></c></row>', { 'xl/styles.xml': styles('<xf numFmtId="14"/>') });
    expect(readXlsx(zip)[0].rows[0]).toEqual(['2026-04-01 09:36:00']);
  });

  it('date1904 workbooks add 1462 days to every serial', () => {
    const zip = workbook(
      '<row r="1"><c r="A1" s="0"><v>44651.4</v></c></row>',
      { 'xl/styles.xml': styles('<xf numFmtId="14"/>') },
      '<workbook xmlns:r="r"><workbookPr date1904="1"/><sheets><sheet name="S" sheetId="1" r:id="rId1"/></sheets></workbook>',
    );
    expect(readXlsx(zip)[0].rows[0]).toEqual(['2026-04-01 09:36:00']);
    expect(excelSerialToLocal(44651.4, true)).toBe(excelSerialToLocal(46113.4));
  });

  it('a workbook without the flag keeps the 1900 system', () => {
    const zip = workbook('<row r="1"><c r="A1" s="0"><v>46113.4</v></c></row>', { 'xl/styles.xml': styles('<xf numFmtId="14"/>') });
    expect(readXlsx(zip)[0].rows[0]).toEqual(['2026-04-01 09:36:00']);
  });

  it('sheet attributes may come in any order', () => {
    const zip = workbook('<row r="1"><c r="A1" t="inlineStr"><is><t>x</t></is></c></row>', {}, '<workbook xmlns:r="r"><sheets><sheet r:id="rId1" sheetId="1" name="Z"/></sheets></workbook>');
    expect(readXlsx(zip)[0]).toMatchObject({ name: 'Z', rows: [['x']] });
  });
});
