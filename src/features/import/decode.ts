import { parseCsv } from './csv';
import { htmlRows } from './html';
import { FileFormatError, MAX_ROWS, readXlsx } from './xlsx';
import type { Tabular } from './types';

export const MAX_FILE_BYTES = 4 * 1024 * 1024;

function decodeText(buf: Buffer): string {
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) return buf.subarray(2).toString('utf16le');
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
    const swapped = Buffer.from(buf.subarray(2));
    swapped.swap16();
    return swapped.toString('utf16le');
  }
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) return buf.subarray(3).toString('utf8');
  // UTF-16LE without BOM: ASCII text has a zero in every odd byte.
  if (buf.length >= 8 && buf[1] === 0 && buf[3] === 0 && buf[5] === 0 && buf[7] === 0) return buf.toString('utf16le');
  return buf.toString('utf8');
}

/** base64 → rows. XLSX (zip magic), HTML (MetaTrader reports) or CSV/text. Throws FileFormatError on bad input. */
export function decodeFile(contentBase64: string, fileName: string): Tabular {
  const buf = Buffer.from(contentBase64, 'base64');
  if (!buf.length) throw new FileFormatError('The file is empty.');
  if (buf.length > MAX_FILE_BYTES) throw new FileFormatError('The file is larger than 4 MB. Export a shorter date range.');
  let t: Tabular;
  if (buf.length >= 4 && buf[0] === 0x50 && buf[1] === 0x4b && buf[2] === 0x03 && buf[3] === 0x04) {
    t = { kind: 'xlsx', fileName, sheets: readXlsx(buf).map((s) => ({ name: s.name, rows: s.rows })) };
  } else {
    const text = decodeText(buf);
    if (/<\s*(table|tr)\b/i.test(text.slice(0, 200_000))) t = { kind: 'html', fileName, sheets: [{ name: 'html', rows: htmlRows(text) }] };
    else t = { kind: 'csv', fileName, sheets: [{ name: 'csv', rows: parseCsv(text) }] };
  }
  const total = t.sheets.reduce((n, s) => n + s.rows.length, 0);
  if (total > MAX_ROWS) throw new FileFormatError(`The file has more than ${MAX_ROWS} rows. Export a shorter date range.`);
  if (total === 0) throw new FileFormatError('No rows could be read from the file.');
  return t;
}
