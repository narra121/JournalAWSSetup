import { describe, expect, it } from 'vitest';
import { decodeFile } from '../decode';
import { parseImport } from '../service';
import { FileFormatError, MAX_CELLS, MAX_COLUMNS, MAX_ROWS, readXlsx } from '../xlsx';
import { makeZip } from './zip';

const workbook = (sheetXml: string, sst = '') =>
  makeZip({
    'xl/workbook.xml': '<workbook xmlns:r="r"><sheets><sheet name="S" sheetId="1" r:id="rId1"/></sheets></workbook>',
    'xl/_rels/workbook.xml.rels': '<Relationships><Relationship Id="rId1" Type="ws" Target="worksheets/sheet1.xml"/></Relationships>',
    ...(sst ? { 'xl/sharedStrings.xml': sst } : {}),
    'xl/worksheets/sheet1.xml': `<worksheet><sheetData>${sheetXml}</sheetData></worksheet>`,
  });

const rowsXml = (n: number, cellsPerRow = 1) =>
  Array.from({ length: n }, (_, i) => `<row r="${i + 1}">${Array.from({ length: cellsPerRow }, (_, j) => `<c r="${String.fromCharCode(65 + (j % 26))}${i + 1}" t="inlineStr"><is><t>x</t></is></c>`).join('')}</row>`).join('');

describe('hostile xlsx', () => {
  it('a cell reference far beyond column XFD is rejected instead of padding the row', () => {
    const t0 = Date.now();
    expect(() => readXlsx(workbook('<row r="1"><c r="ZZZZZZZZ1" t="inlineStr"><is><t>boom</t></is></c></row>'))).toThrow(FileFormatError);
    expect(Date.now() - t0).toBeLessThan(2000);
  });

  it('column XFD (16,384th) is accepted, XFE is not', () => {
    const ok = readXlsx(workbook('<row r="1"><c r="XFD1" t="inlineStr"><is><t>edge</t></is></c></row>'));
    expect(ok[0].rows[0]).toHaveLength(MAX_COLUMNS);
    expect(ok[0].rows[0][MAX_COLUMNS - 1]).toBe('edge');
    expect(() => readXlsx(workbook('<row r="1"><c r="XFE1" t="inlineStr"><is><t>x</t></is></c></row>'))).toThrow(/column beyond/);
  });

  it('sparse padding counts as cells: many rows each reaching column XFD stop at the cell cap', () => {
    const wide = Array.from({ length: 200 }, (_, i) => `<row r="${i + 1}"><c r="XFD${i + 1}" t="inlineStr"><is><t>x</t></is></c></row>`).join('');
    expect(MAX_COLUMNS * 200).toBeGreaterThan(MAX_CELLS);
    expect(() => readXlsx(workbook(wide))).toThrow(/too many cells/);
  });

  it('stops at the row cap while parsing, before the whole sheet is built', () => {
    expect(() => readXlsx(workbook(rowsXml(MAX_ROWS + 1)))).toThrow(new RegExp(`more than ${MAX_ROWS} rows`));
    expect(readXlsx(workbook(rowsXml(MAX_ROWS)))[0].rows).toHaveLength(MAX_ROWS);
  });

  it('rows are counted across sheets', () => {
    const xml = (n: number) => `<worksheet><sheetData>${rowsXml(n)}</sheetData></worksheet>`;
    const zip = makeZip({
      'xl/workbook.xml': '<workbook xmlns:r="r"><sheets><sheet name="A" sheetId="1" r:id="rId1"/><sheet name="B" sheetId="2" r:id="rId2"/></sheets></workbook>',
      'xl/_rels/workbook.xml.rels': '<Relationships><Relationship Id="rId1" Type="ws" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="ws" Target="worksheets/sheet2.xml"/></Relationships>',
      'xl/worksheets/sheet1.xml': xml(MAX_ROWS - 10),
      'xl/worksheets/sheet2.xml': xml(20),
    });
    expect(() => readXlsx(zip)).toThrow(/more than/);
  });

  it('too many shared strings are refused', () => {
    const sst = `<sst>${'<si><t>a</t></si>'.repeat(MAX_CELLS + 1)}</sst>`;
    expect(() => readXlsx(workbook('<row r="1"/>', sst))).toThrow(/shared strings/);
  });

  it('a zip bomb (tiny file, huge inflated XML) is refused by the output budget', () => {
    const bomb = makeZip({
      'xl/workbook.xml': '<workbook xmlns:r="r"><sheets><sheet name="S" sheetId="1" r:id="rId1"/></sheets></workbook>',
      'xl/_rels/workbook.xml.rels': '<Relationships><Relationship Id="rId1" Type="ws" Target="worksheets/sheet1.xml"/></Relationships>',
      'xl/worksheets/sheet1.xml': `<worksheet><sheetData>${' '.repeat(41 * 1024 * 1024)}</sheetData></worksheet>`,
    });
    expect(bomb.length).toBeLessThan(200_000);
    expect(() => readXlsx(bomb)).toThrow(FileFormatError);
  });

  it('a corrupt directory and truncated entries fail cleanly', () => {
    const good = workbook(rowsXml(2));
    expect(() => readXlsx(good.subarray(0, good.length - 30))).toThrow(FileFormatError);
    const bad = Buffer.from(good);
    bad.writeUInt32LE(0xdeadbeef, bad.length - 22 + 16); // central directory offset
    expect(() => readXlsx(bad)).toThrow(FileFormatError);
  });

  it('through the import service a hostile workbook is a warning, not a crash, and costs no trades', () => {
    const b64 = workbook('<row r="1"><c r="ZZZZZZZZ1" t="inlineStr"><is><t>boom</t></is></c></row>').toString('base64');
    const r = parseImport({ source: 'auto', fileName: 'evil.xlsx', contentBase64: b64 });
    expect(r).toMatchObject({ detectedSource: 'unknown', trades: [] });
    expect(r.warnings[0]).toMatch(/column beyond/);
    expect(() => decodeFile(b64, 'evil.xlsx')).toThrow(FileFormatError);
  });
});
