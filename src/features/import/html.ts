import type { Row } from './csv';
import { decodeXmlEntities, ScanBudget } from './xlsx';

/** Attribute text past this length is not looked at (class and colspan sit at the start of real tags). */
const MAX_ATTR_CHARS = 2048;

interface OpenCell {
  parts: string[];
  attrs: string;
}

const isLetter = (ch: string | undefined) => ch !== undefined && /[A-Za-z]/.test(ch);

function cleanText(raw: string): string {
  return decodeXmlEntities(raw.replace(/&nbsp;/gi, ' ')).replace(/\s+/g, ' ').trim();
}

/**
 * Rows of every <tr> in document order (tables are not separated: MT4/MT5 reports put section titles
 * like "Closed Transactions:" or "Positions" in their own rows, which parsers use as section markers).
 * A cell with colspan=N is followed by N-1 empty cells so column positions stay aligned. Cells with class
 * "hidden" are dropped: MT5 Positions rows carry a hidden colspan=8 cell that is not a column.
 *
 * One pass with indexOf, so the work is linear in the file size: comments and <script>/<style> sections are
 * skipped, and the rest of the file is dropped when such a section never ends or a tag has no closing ">".
 */
export function htmlRows(html: string): Row[] {
  const scan = new ScanBudget();
  const rows: Row[] = [];
  let row: string[] | null = null;
  let cell: OpenCell | null = null;
  let lower: string | undefined;

  const closeCell = () => {
    const done = cell as OpenCell | null;
    cell = null;
    if (!done || !row) return;
    if (/class\s*=\s*["']?[^"'>]*\bhidden\b/i.test(done.attrs)) return;
    row.push(cleanText(done.parts.join('')));
    const span = Number(/colspan\s*=\s*["']?(\d+)/i.exec(done.attrs)?.[1] ?? 1);
    for (let k = 1; k < Math.min(span, 50); k++) row.push('');
  };
  const closeRow = () => {
    const done = row as string[] | null;
    row = null;
    if (done && done.some((c) => c !== '')) rows.push(done);
  };
  const addText = (text: string) => {
    const open = cell as OpenCell | null;
    if (open && text) open.parts.push(text);
  };

  let pos = 0;
  while (pos < html.length) {
    const lt = html.indexOf('<', pos);
    addText(html.slice(pos, lt < 0 ? undefined : lt));
    if (lt < 0) break;

    if (html.startsWith('<!--', lt)) {
      const end = html.indexOf('-->', lt + 4);
      if (end < 0) break;
      pos = end + 3;
      continue;
    }
    const closing = html[lt + 1] === '/';
    if (!isLetter(html[lt + (closing ? 2 : 1)])) {
      if (html[lt + 1] === '!' || html[lt + 1] === '?') {
        // "<!DOCTYPE …>" or "<?xml …?>"
        const end = html.indexOf('>', lt + 2);
        if (end < 0) break;
        pos = end + 1;
      } else {
        addText('<');
        pos = lt + 1;
      }
      continue;
    }
    scan.hit();
    const gt = html.indexOf('>', lt + 1);
    if (gt < 0) break;
    const tag = html.slice(lt + (closing ? 2 : 1), gt);
    const nameEnd = tag.search(/[\s/]/);
    const name = (nameEnd < 0 ? tag : tag.slice(0, nameEnd)).toLowerCase();
    const attrs = nameEnd < 0 ? '' : tag.slice(nameEnd, nameEnd + MAX_ATTR_CHARS);
    pos = gt + 1;

    if (!closing && (name === 'script' || name === 'style')) {
      lower ??= html.replace(/[A-Z]+/g, (m) => m.toLowerCase());
      const end = lower.indexOf(`</${name}>`, pos);
      if (end < 0) break;
      pos = end + name.length + 3;
    } else if (name === 'tr' && !closing) {
      closeCell();
      closeRow();
      row = [];
    } else if (name === 'table' && closing) {
      closeCell();
      closeRow();
    } else if (name === 'tr') {
      closeCell();
    } else if ((name === 'td' || name === 'th') && !closing) {
      closeCell();
      if (row) cell = { parts: [], attrs };
    } else if (name === 'br') {
      addText(' ');
    }
  }
  closeCell();
  closeRow();
  return rows;
}
