import { inflateRawSync } from 'node:zlib';
import type { Row } from './csv';

export class FileFormatError extends Error {}

const MAX_UNCOMPRESSED = 40 * 1024 * 1024;
/** Excel's own column limit (XFD). A cell reference beyond it is never legitimate. */
export const MAX_COLUMNS = 16_384;
export const MAX_ROWS = 50_000;
/** Cells, including padding for sparse columns and shared strings, across the whole workbook. */
export const MAX_CELLS = 2_000_000;
/** Tags the scanners may look at in one file; more is a hostile or broken file, not a trade history. */
export const MAX_TAGS = 10_000_000;
/** Days between the 1900 and the 1904 date system. */
const DATE_1904_OFFSET = 1462;

interface ZipEntry {
  name: string;
  method: number;
  compressedSize: number;
  localOffset: number;
}

function readEntries(buf: Buffer): ZipEntry[] {
  // End of central directory record: signature 0x06054b50, searched backwards (comment ≤ 64 KiB).
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65535); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new FileFormatError('Not a valid XLSX (zip) file');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const out: ZipEntry[] = [];
  for (let n = 0; n < count; n++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) throw new FileFormatError('Corrupt XLSX directory');
    const method = buf.readUInt16LE(p + 10);
    const compressedSize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOffset = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    out.push({ name, method, compressedSize, localOffset });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

function readEntry(buf: Buffer, e: ZipEntry, budget: { left: number }): string {
  const p = e.localOffset;
  if (p + 30 > buf.length || buf.readUInt32LE(p) !== 0x04034b50) throw new FileFormatError('Corrupt XLSX entry');
  const start = p + 30 + buf.readUInt16LE(p + 26) + buf.readUInt16LE(p + 28);
  if (start + e.compressedSize > buf.length) throw new FileFormatError('Corrupt XLSX entry');
  const data = buf.subarray(start, start + e.compressedSize);
  let raw: Buffer;
  if (e.method === 0) raw = Buffer.from(data);
  else if (e.method === 8) {
    try {
      raw = inflateRawSync(data, { maxOutputLength: budget.left });
    } catch {
      throw new FileFormatError('XLSX is too large or corrupt');
    }
  } else throw new FileFormatError(`Unsupported XLSX compression ${e.method}`);
  budget.left -= raw.length;
  if (budget.left <= 0) throw new FileFormatError('XLSX is too large');
  return raw.toString('utf8');
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
export function decodeXmlEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, g: string) => {
    if (g[0] === '#') {
      const code = g[1] === 'x' || g[1] === 'X' ? parseInt(g.slice(2), 16) : parseInt(g.slice(1), 10);
      return Number.isFinite(code) && code <= 0x10ffff ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[g.toLowerCase()] ?? m;
  });
}

/** Counts the tags a file makes the scanners look at; one scan per file. */
export class ScanBudget {
  private tags = 0;
  hit(): void {
    if (++this.tags > MAX_TAGS) throw new FileFormatError('The file has too many elements. Export a shorter date range.');
  }
}

const isNameEnd = (ch: string | undefined) => ch === undefined || ch === '>' || ch === '/' || ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r';

export interface XmlElement {
  attrs: string;
  body: string;
}

/**
 * Elements `<name attrs>body</name>` and `<name attrs/>` in document order, found with indexOf only: every position
 * is visited once, so the work is linear in the input. An element is not entered again from inside its body, and
 * scanning stops at an element with no end (a lazy regex would rescan the rest of the input for every such tag).
 */
export function* elements(xml: string, name: string, budget: ScanBudget): Generator<XmlElement> {
  const open = `<${name}`;
  const close = `</${name}>`;
  let pos = 0;
  for (;;) {
    const at = xml.indexOf(open, pos);
    if (at < 0) return;
    if (!isNameEnd(xml[at + open.length])) {
      pos = at + open.length;
      continue;
    }
    budget.hit();
    const gt = xml.indexOf('>', at + open.length);
    if (gt < 0) return;
    if (xml[gt - 1] === '/') {
      yield { attrs: xml.slice(at + open.length, gt - 1), body: '' };
      pos = gt + 1;
      continue;
    }
    const end = xml.indexOf(close, gt + 1);
    if (end < 0) return;
    yield { attrs: xml.slice(at + open.length, gt), body: xml.slice(gt + 1, end) };
    pos = end + close.length;
  }
}

/** Only the opening tags `<name attrs>` or `<name attrs/>` (for elements whose children are not read). */
export function* openTags(xml: string, name: string, budget: ScanBudget): Generator<string> {
  const open = `<${name}`;
  let pos = 0;
  for (;;) {
    const at = xml.indexOf(open, pos);
    if (at < 0) return;
    pos = at + open.length;
    if (!isNameEnd(xml[pos])) continue;
    budget.hit();
    const gt = xml.indexOf('>', pos);
    if (gt < 0) return;
    yield xml.slice(pos, gt);
    pos = gt + 1;
  }
}

const attr = (attrs: string, name: string): string | undefined => new RegExp(`(?:^|\\s)${name}="([^"]*)"`).exec(attrs)?.[1];

function textOf(xml: string, budget: ScanBudget): string {
  let s = '';
  for (const t of elements(xml, 't', budget)) s += t.body;
  return decodeXmlEntities(s);
}

function colIndex(ref: string): number {
  let n = 0;
  for (const ch of ref.replace(/\d+$/, '')) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

/** Excel serial date (1900 system, or 1904 when `date1904`) → 'YYYY-MM-DD HH:MM:SS' local wall-clock string. */
export function excelSerialToLocal(serial: number, date1904 = false): string {
  const ms = Math.round((serial + (date1904 ? DATE_1904_OFFSET : 0) - 25569) * 86400000);
  return new Date(ms).toISOString().replace('T', ' ').slice(0, 19);
}

export interface Sheet {
  name: string;
  rows: Row[];
}

/**
 * Minimal XLSX reader: values of every worksheet as strings. Numeric cells with a date number format are
 * returned as 'YYYY-MM-DD HH:MM:SS' wall-clock text so parsers handle CSV and XLSX identically.
 */
export function readXlsx(buf: Buffer): Sheet[] {
  const entries = readEntries(buf);
  const byName = new Map(entries.map((e) => [e.name, e]));
  const budget = { left: MAX_UNCOMPRESSED };
  const scan = new ScanBudget();
  const get = (n: string) => {
    const e = byName.get(n);
    return e ? readEntry(buf, e, budget) : '';
  };

  const shared: string[] = [];
  const sst = get('xl/sharedStrings.xml');
  for (const si of elements(sst, 'si', scan)) {
    if (shared.length >= MAX_CELLS) throw new FileFormatError('XLSX has too many shared strings');
    shared.push(textOf(si.body, scan));
  }

  // Styles: which cellXfs indexes use a date/time number format.
  const styles = get('xl/styles.xml');
  const customFmt = new Map<number, string>();
  for (const attrs of openTags(styles, 'numFmt', scan)) {
    const id = attr(attrs, 'numFmtId');
    const code = attr(attrs, 'formatCode');
    if (id !== undefined && code !== undefined) customFmt.set(Number(id), decodeXmlEntities(code));
  }
  const dateXf = new Set<number>();
  const xfsBlock = elements(styles, 'cellXfs', scan).next().value?.body ?? '';
  let xfIndex = 0;
  // Every <xf> counts, also one without numFmtId (it means 0, General): the style index is the position.
  for (const attrs of openTags(xfsBlock, 'xf', scan)) {
    const id = Number(attr(attrs, 'numFmtId') ?? 0);
    const code = customFmt.get(id) ?? '';
    const builtInDate = (id >= 14 && id <= 22) || (id >= 45 && id <= 47);
    const customDate = /[dmyhs]/i.test(code.replace(/"[^"]*"|\[[^\]]*\]/g, '')) && !/^[#0.,%\s]+$/.test(code);
    if (builtInDate || (code && customDate)) dateXf.add(xfIndex);
    xfIndex++;
  }

  const workbook = get('xl/workbook.xml');
  const rels = get('xl/_rels/workbook.xml.rels');
  const relTarget = new Map<string, string>();
  for (const attrs of openTags(rels, 'Relationship', scan)) {
    const id = attr(attrs, 'Id');
    const target = attr(attrs, 'Target');
    if (id !== undefined && target !== undefined) relTarget.set(id, target);
  }
  const date1904 = [...openTags(workbook, 'workbookPr', scan)].some((attrs) => /^(1|true)$/i.test(attr(attrs, 'date1904') ?? ''));

  const sheets: Sheet[] = [];
  let totalRows = 0;
  let totalCells = 0;
  for (const attrs of openTags(workbook, 'sheet', scan)) {
    const sheetName = attr(attrs, 'name');
    const rid = attr(attrs, 'r:id');
    if (sheetName === undefined || rid === undefined) continue;
    const target = relTarget.get(rid);
    if (!target) continue;
    const path = target.startsWith('/') ? target.slice(1) : `xl/${target.replace(/^\.\//, '')}`;
    const xml = get(path);
    if (!xml) continue;
    const rows: Row[] = [];
    for (const r of elements(xml, 'row', scan)) {
      const row: string[] = [];
      for (const c of elements(r.body, 'c', scan)) {
        const attrs = c.attrs;
        const body = c.body;
        const ref = /r="([A-Z]+\d+)"/.exec(attrs)?.[1];
        const t = /t="(\w+)"/.exec(attrs)?.[1];
        const s = Number(/s="(\d+)"/.exec(attrs)?.[1] ?? -1);
        const v = elements(body, 'v', scan).next().value?.body;
        let value = '';
        if (t === 's' && v != null) value = shared[Number(v)] ?? '';
        else if (t === 'inlineStr') value = textOf(body, scan);
        else if (t === 'str' || t === 'e') value = decodeXmlEntities(v ?? '');
        else if (t === 'b') value = v === '1' ? 'TRUE' : 'FALSE';
        else if (v != null) value = dateXf.has(s) && Number.isFinite(Number(v)) ? excelSerialToLocal(Number(v), date1904) : v;
        const idx = ref ? colIndex(ref) : row.length;
        if (idx >= MAX_COLUMNS) throw new FileFormatError('XLSX has a column beyond the supported range');
        while (row.length < idx) row.push('');
        row[idx] = value.trim();
      }
      totalCells += row.length;
      if (totalCells > MAX_CELLS) throw new FileFormatError('XLSX has too many cells. Export a shorter date range.');
      if (row.some((x) => x !== '')) {
        if (++totalRows > MAX_ROWS) throw new FileFormatError(`The file has more than ${MAX_ROWS} rows. Export a shorter date range.`);
        rows.push(row);
      }
    }
    sheets.push({ name: decodeXmlEntities(sheetName), rows });
  }
  if (!sheets.length) throw new FileFormatError('XLSX has no readable sheets');
  return sheets;
}
