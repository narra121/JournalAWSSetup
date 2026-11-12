import type { Row } from './csv';
import { decodeXmlEntities } from './xlsx';

/**
 * Rows of every <tr> in document order (tables are not separated: MT4/MT5 reports put section titles
 * like "Closed Transactions:" or "Positions" in their own rows, which parsers use as section markers).
 * A cell with colspan=N is followed by N-1 empty cells so column positions stay aligned. Cells with class
 * "hidden" are dropped: MT5 Positions rows carry a hidden colspan=8 cell that is not a column.
 */
export function htmlRows(html: string): Row[] {
  const clean = html.replace(/<!--[\s\S]*?-->/g, '').replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, '');
  const rows: Row[] = [];
  for (const tr of clean.matchAll(/<tr\b[^>]*>([\s\S]*?)(?=<tr\b|<\/table>|$)/gi)) {
    const row: string[] = [];
    for (const td of tr[1].matchAll(/<t([dh])\b([^>]*)>([\s\S]*?)(?=<t[dh]\b|<\/tr>|$)/gi)) {
      if (/class\s*=\s*["']?[^"'>]*\bhidden\b/i.test(td[2])) continue;
      const text = decodeXmlEntities(
        td[3]
          .replace(/<br\s*\/?>/gi, ' ')
          .replace(/<[^>]+>/g, '')
          .replace(/&nbsp;/gi, ' '),
      )
        .replace(/\s+/g, ' ')
        .trim();
      row.push(text);
      const span = Number(/colspan\s*=\s*["']?(\d+)/i.exec(td[2])?.[1] ?? 1);
      for (let k = 1; k < Math.min(span, 50); k++) row.push('');
    }
    if (row.some((c) => c !== '')) rows.push(row);
  }
  return rows;
}
