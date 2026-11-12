import type { Row } from '../csv';
import { normHeader, num, parseLocalDateTime, toUtcIso } from '../table';
import { parseIndianSymbol } from '../symbols';
import type { CanonicalField, ClosedTrade, Fill, ImportParser, ParseContext, ParserOutput, Tabular } from '../types';
import { parseSide } from './fills';

const ALIASES: Record<CanonicalField, string[]> = {
  symbol: ['symbol', 'instrument', 'ticker', 'scrip', 'script', 'stock', 'stock name', 'name', 'item', 'asset', 'pair', 'contract'],
  side: ['side', 'type', 'direction', 'buy sell', 'trade type', 'action', 'transaction type', 'b s'],
  quantity: ['quantity', 'qty', 'size', 'volume', 'lots', 'units', 'shares', 'traded qty'],
  price: ['price', 'trade price', 'avg price', 'average price', 'rate', 'fill price'],
  time: ['time', 'datetime', 'date time', 'timestamp', 'executed at', 'execution time', 'trade time'],
  date: ['date', 'trade date'],
  tradeId: ['trade id', 'trade no', 'trade num', 'ticket', 'deal', 'id', 'execution id'],
  orderId: ['order id', 'order no', 'order num'],
  entryPrice: ['entry price', 'entry', 'open price', 'buy price', 'avg buy price', 'buy avg'],
  exitPrice: ['exit price', 'exit', 'close price', 'sell price', 'avg sell price', 'sell avg'],
  openTime: ['open time', 'entry time', 'open date', 'entry date', 'opened', 'opened at'],
  closeTime: ['close time', 'exit time', 'close date', 'exit date', 'closed', 'closed at'],
  pnl: ['pnl', 'p l', 'profit', 'profit loss', 'realized p l', 'net p l', 'net pnl', 'gross p l'],
  fees: ['fees', 'charges', 'commission', 'brokerage', 'total charges'],
  stopLoss: ['stop loss', 'sl', 's l', 'stop'],
  takeProfit: ['take profit', 'tp', 't p', 'target'],
};

function suggest(headers: string[]): Partial<Record<CanonicalField, string>> {
  const normed = headers.map(normHeader);
  const out: Partial<Record<CanonicalField, string>> = {};
  const used = new Set<number>();
  for (const f of Object.keys(ALIASES) as CanonicalField[]) {
    for (const a of ALIASES[f]) {
      const i = normed.findIndex((h, j) => h === a && !used.has(j));
      if (i >= 0) {
        out[f] = headers[i];
        used.add(i);
        break;
      }
    }
  }
  return out;
}

function headerRow(t: Tabular, ctx?: ParseContext): { rows: Row[]; index: number } | null {
  const want = ctx?.mapping ? Object.values(ctx.mapping).map((v) => normHeader(String(v))) : null;
  for (const s of t.sheets) {
    for (let i = 0; i < Math.min(s.rows.length, 60); i++) {
      const normed = s.rows[i].map(normHeader);
      if (want ? want.every((w) => normed.includes(w)) : Object.keys(suggest(s.rows[i])).length >= 3) return { rows: s.rows, index: i };
    }
  }
  return null;
}

function parseGeneric(t: Tabular, ctx: ParseContext): ParserOutput {
  const found = headerRow(t, ctx);
  if (!found) {
    const first = t.sheets.flatMap((s) => s.rows).find((r) => r.filter(Boolean).length >= 2) ?? [];
    return { kind: 'needsMapping', headers: first.filter(Boolean), suggested: {} };
  }
  const headers = found.rows[found.index];
  const mapping = { ...suggest(headers), ...(ctx.mapping ?? {}) };
  const normed = headers.map(normHeader);
  const idx = (f: CanonicalField) => {
    const h = mapping[f];
    return h == null ? -1 : normed.indexOf(normHeader(h));
  };
  const hasClosed = ['symbol', 'side', 'quantity', 'entryPrice', 'exitPrice'].every((f) => idx(f as CanonicalField) >= 0) && (idx('openTime') >= 0 || idx('time') >= 0 || idx('date') >= 0);
  const hasFills = ['symbol', 'side', 'quantity', 'price'].every((f) => idx(f as CanonicalField) >= 0) && (idx('time') >= 0 || idx('date') >= 0);
  if (!hasClosed && !hasFills) return { kind: 'needsMapping', headers: headers.filter(Boolean), suggested: mapping };

  const data = found.rows.slice(found.index + 1);
  const cell = (r: Row, f: CanonicalField) => (idx(f) >= 0 ? r[idx(f)] ?? '' : '');
  const when = (r: Row, primary: CanonicalField) => {
    const raw = cell(r, primary) || cell(r, 'time') || cell(r, 'date');
    const d = parseLocalDateTime(raw, !cell(r, primary) && cell(r, 'date') && cell(r, 'time') ? cell(r, 'time') : '');
    return d ? toUtcIso(d, ctx.utcOffsetMinutes) : null;
  };
  let skipped = 0;

  if (hasClosed) {
    const trades: ClosedTrade[] = [];
    for (const r of data) {
      if (r.every((c) => c === '')) continue;
      const side = parseSide(cell(r, 'side'));
      const qty = num(cell(r, 'quantity'));
      const entry = num(cell(r, 'entryPrice'));
      const exit = num(cell(r, 'exitPrice'));
      const open = when(r, 'openTime');
      const close = (idx('closeTime') >= 0 ? when(r, 'closeTime') : null) ?? open;
      const symbol = cell(r, 'symbol').trim().toUpperCase();
      if (!side || !qty || entry == null || exit == null || !open || !close || !symbol) {
        skipped++;
        continue;
      }
      const sl = num(cell(r, 'stopLoss'));
      const tp = num(cell(r, 'takeProfit'));
      const pnl = num(cell(r, 'pnl'));
      const fees = num(cell(r, 'fees'));
      trades.push({
        ...parseIndianSymbol(symbol), side, quantity: qty, entryPrice: entry, exitPrice: exit, openTime: open, closeTime: close,
        externalId: cell(r, 'tradeId') || `row:${symbol}:${open}:${side}:${qty}:${entry}`,
        grossProfit: pnl ?? undefined, fees: fees != null ? Math.abs(fees) : undefined,
        stopLoss: sl && sl > 0 ? sl : null, takeProfit: tp && tp > 0 ? tp : null,
      });
    }
    return { kind: 'closed', trades, skipped };
  }

  const fills: Fill[] = [];
  const seq = new Map<string, number>();
  for (const r of data) {
    if (r.every((c) => c === '')) continue;
    const side = parseSide(cell(r, 'side'));
    const qty = num(cell(r, 'quantity'));
    const price = num(cell(r, 'price'));
    const time = when(r, 'time');
    const symbol = cell(r, 'symbol').trim().toUpperCase();
    if (!side || !qty || price == null || !time || !symbol) {
      skipped++;
      continue;
    }
    let tradeId = cell(r, 'tradeId');
    if (!tradeId) {
      const k = `${symbol}|${side}|${time}`;
      const n = (seq.get(k) ?? 0) + 1;
      seq.set(k, n);
      tradeId = `${k}#${n}`;
    }
    fills.push({ ...parseIndianSymbol(symbol), side, quantity: qty, price, time, tradeId, orderId: cell(r, 'orderId') || undefined });
  }
  return { kind: 'fills', fills, skipped };
}

export const genericCsv: ImportParser = {
  id: 'generic_csv',
  name: 'Other broker (CSV / Excel)',
  assetClasses: ['stock', 'forex', 'futures', 'options', 'crypto', 'cfd', 'commodity'],
  fileTypes: ['csv', 'xlsx'],
  howToExport: 'Export your trade history as CSV or Excel. You will be asked to match the columns on the next step.',
  sampleColumns: ['Symbol', 'Side', 'Quantity', 'Entry Price', 'Exit Price', 'Open Time', 'Close Time'],
  defaultUtcOffsetMinutes: 330,
  // Never wins auto-detection; used only when chosen explicitly or as the fallback with a mapping step.
  detect: () => 1,
  parse: parseGeneric,
};
