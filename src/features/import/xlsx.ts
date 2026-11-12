import { inflateRawSync } from 'node:zlib';
import type { Row } from './csv';

export class FileFormatError extends Error {}

const MAX_UNCOMPRESSED = 40 * 1024 * 1024;
/** Excel's own column limit (XFD). A cell reference beyond it is never legitimate. */
export const MAX_COLUMNS = 16_384;
export const MAX_ROWS = 50_000;
/** Cells, including padding for sparse columns and shared strings, across the whole workbook. */
export const MAX_CELLS = 2_000_000;

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
  if (buf.readUInt32LE(p) !== 0x04034b50) throw new FileFormatError('Corrupt XLSX entry');
  const start = p + 30 + buf.readUInt16LE(p + 26) + buf.readUInt16LE(p + 28);
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
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[g.toLowerCase()] ?? m;
  });
}

function textOf(xml: string): string {
  let s = '';
  for (const m of xml.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)) s += m[1];
  return decodeXmlEntities(s);
}

function colIndex(ref: string): number {
  let n = 0;
  for (const ch of ref.replace(/\d+$/, '')) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

/** Excel serial date (1900 system) → 'YYYY-MM-DD HH:MM:SS' local wall-clock string. */
export function excelSerialToLocal(serial: number): string {
  const ms = Math.round((serial - 25569) * 86400000);
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
  const get = (n: string) => {
    const e = byName.get(n);
    return e ? readEntry(buf, e, budget) : '';
  };

  const shared: string[] = [];
  const sst = get('xl/sharedStrings.xml');
  for (const m of sst.matchAll(/<si>([\s\S]*?)<\/si>/g)) {
    if (shared.length >= MAX_CELLS) throw new FileFormatError('XLSX has too many shared strings');
    shared.push(textOf(m[1]));
  }

  // Styles: which cellXfs indexes use a date/time number format.
  const styles = get('xl/styles.xml');
  const customFmt = new Map<number, string>();
  for (const m of styles.matchAll(/<numFmt\s+numFmtId="(\d+)"\s+formatCode="([^"]*)"/g)) customFmt.set(Number(m[1]), decodeXmlEntities(m[2]));
  const dateXf = new Set<number>();
  const xfsBlock = /<cellXfs[^>]*>([\s\S]*?)<\/cellXfs>/.exec(styles)?.[1] ?? '';
  let xfIndex = 0;
  for (const m of xfsBlock.matchAll(/<xf\s[^>]*?numFmtId="(\d+)"[^>]*?\/?>/g)) {
    const id = Number(m[1]);
    const code = customFmt.get(id) ?? '';
    const builtInDate = (id >= 14 && id <= 22) || (id >= 45 && id <= 47);
    const customDate = /[dmyhs]/i.test(code.replace(/"[^"]*"|\[[^\]]*\]/g, '')) && !/^[#0.,%\s]+$/.test(code);
    if (builtInDate || (code && customDate)) dateXf.add(xfIndex);
    xfIndex++;
  }

  const workbook = get('xl/workbook.xml');
  const rels = get('xl/_rels/workbook.xml.rels');
  const relTarget = new Map<string, string>();
  for (const m of rels.matchAll(/<Relationship\s[^>]*?Id="([^"]+)"[^>]*?Target="([^"]+)"/g)) relTarget.set(m[1], m[2]);
  for (const m of rels.matchAll(/<Relationship\s[^>]*?Target="([^"]+)"[^>]*?Id="([^"]+)"/g)) relTarget.set(m[2], m[1]);

  const sheets: Sheet[] = [];
  let totalRows = 0;
  let totalCells = 0;
  for (const m of workbook.matchAll(/<sheet\s[^>]*?name="([^"]*)"[^>]*?r:id="([^"]+)"/g)) {
    const target = relTarget.get(m[2]);
    if (!target) continue;
    const path = target.startsWith('/') ? target.slice(1) : `xl/${target.replace(/^\.\//, '')}`;
    const xml = get(path);
    if (!xml) continue;
    const rows: Row[] = [];
    for (const r of xml.matchAll(/<row\b[^>]*?(?:\/>|>([\s\S]*?)<\/row>)/g)) {
      const row: string[] = [];
      for (const c of (r[1] ?? '').matchAll(/<c\s([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const attrs = c[1];
        const body = c[2] ?? '';
        const ref = /r="([A-Z]+\d+)"/.exec(attrs)?.[1];
        const t = /t="(\w+)"/.exec(attrs)?.[1];
        const s = Number(/s="(\d+)"/.exec(attrs)?.[1] ?? -1);
        const v = /<v>([\s\S]*?)<\/v>/.exec(body)?.[1];
        let value = '';
        if (t === 's' && v != null) value = shared[Number(v)] ?? '';
        else if (t === 'inlineStr') value = textOf(body);
        else if (t === 'str' || t === 'e') value = decodeXmlEntities(v ?? '');
        else if (t === 'b') value = v === '1' ? 'TRUE' : 'FALSE';
        else if (v != null) value = dateXf.has(s) && Number.isFinite(Number(v)) ? excelSerialToLocal(Number(v)) : v;
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
    sheets.push({ name: decodeXmlEntities(m[1]), rows });
  }
  if (!sheets.length) throw new FileFormatError('XLSX has no readable sheets');
  return sheets;
}
