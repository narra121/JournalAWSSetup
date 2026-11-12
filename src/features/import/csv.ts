export type Row = string[];

/** Picks the delimiter that yields the most columns consistently over the first lines. */
export function sniffDelimiter(text: string): string {
  const sample = text.split(/\r?\n/).filter((l) => l.trim()).slice(0, 10);
  let best = ',';
  let bestScore = -1;
  for (const d of [',', ';', '\t', '|']) {
    const counts = sample.map((l) => splitLine(l, d).length);
    const min = Math.min(...counts);
    const score = min > 1 ? min * 10 - (Math.max(...counts) - min) : 0;
    if (score > bestScore) {
      best = d;
      bestScore = score;
    }
  }
  return best;
}

function splitLine(line: string, d: string): string[] {
  return parseCsv(line, d)[0] ?? [];
}

/** RFC 4180: quoted fields, doubled quotes, embedded delimiters/newlines, CRLF or LF. Cells are trimmed. */
export function parseCsv(text: string, delimiter = sniffDelimiter(text)): Row[] {
  const rows: Row[] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  let i = 0;
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  while (i < src.length) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          cell += '"';
          i += 2;
          continue;
        }
        quoted = false;
        i++;
        continue;
      }
      cell += ch;
      i++;
      continue;
    }
    if (ch === '"' && cell.trim() === '') {
      quoted = true;
      cell = '';
      i++;
      continue;
    }
    if (ch === delimiter) {
      row.push(cell.trim());
      cell = '';
      i++;
      continue;
    }
    if (ch === '\r' || ch === '\n') {
      row.push(cell.trim());
      rows.push(row);
      row = [];
      cell = '';
      if (ch === '\r' && src[i + 1] === '\n') i++;
      i++;
      continue;
    }
    cell += ch;
    i++;
  }
  if (cell !== '' || row.length) {
    row.push(cell.trim());
    rows.push(row);
  }
  return rows.filter((r) => r.some((c) => c !== ''));
}
