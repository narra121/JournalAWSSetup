import type { Row } from '../csv';
import { normHeader, num, parseLocalDateTime, toUtcIso } from '../table';
import { mtAssetClass, normalizeMtSymbol } from '../symbols';
import type { ClosedTrade, ImportParser, ParseContext, ParserOutput, Tabular } from '../types';
import { parseSide } from './fills';

/** Index of the n-th (0-based) header equal to `name` in a normalised header row; -1 when absent. */
function nth(headers: string[], name: string, n = 0): number {
  let seen = -1;
  for (let i = 0; i < headers.length; i++) if (headers[i] === name && ++seen === n) return i;
  return -1;
}

function contractSize(symbol: string): number | undefined {
  const s = symbol.toUpperCase();
  if (s.startsWith('XAU')) return 100;
  if (s.startsWith('XAG')) return 5000;
  return mtAssetClass(s) === 'forex' ? 100000 : undefined;
}

interface MtLayout {
  headerIndex: number;
  rows: Row[];
  col: { id: number; open: number; type: number; size: number; item: number; entry: number; sl: number; tp: number; close: number; exit: number; commission: number; taxes: number; swap: number; profit: number };
}

const REQUIRED = ['mt4', 'mt5'] as const;

function layout(t: Tabular, kind: (typeof REQUIRED)[number]): MtLayout | null {
  for (const s of t.sheets) {
    for (let i = 0; i < Math.min(s.rows.length, 400); i++) {
      const h = s.rows[i].map(normHeader);
      if (kind === 'mt4') {
        // The lots column is "Size", "Volume" or (older builds) "Lots" depending on the terminal build.
        const size = Math.max(nth(h, 'size'), nth(h, 'volume'), nth(h, 'lots'));
        if (!(h.includes('ticket') && h.includes('open time') && h.includes('close time') && size >= 0 && h.includes('item'))) continue;
        return {
          headerIndex: i, rows: s.rows,
          col: { id: nth(h, 'ticket'), open: nth(h, 'open time'), type: nth(h, 'type'), size, item: nth(h, 'item'), entry: nth(h, 'price', 0), sl: nth(h, 's l'), tp: nth(h, 't p'), close: nth(h, 'close time'), exit: nth(h, 'price', 1), commission: nth(h, 'commission'), taxes: nth(h, 'taxes'), swap: nth(h, 'swap'), profit: nth(h, 'profit') },
        };
      }
      if (!(h.includes('position') && h.includes('symbol') && h.includes('volume') && h.includes('swap') && h.includes('profit') && nth(h, 'time', 1) >= 0)) continue;
      return {
        headerIndex: i, rows: s.rows,
        col: { id: nth(h, 'position'), open: nth(h, 'time', 0), type: nth(h, 'type'), size: nth(h, 'volume'), item: nth(h, 'symbol'), entry: nth(h, 'price', 0), sl: nth(h, 's l'), tp: nth(h, 't p'), close: nth(h, 'time', 1), exit: nth(h, 'price', 1), commission: nth(h, 'commission'), taxes: -1, swap: nth(h, 'swap'), profit: nth(h, 'profit') },
      };
    }
  }
  return null;
}

function parseMt(kind: (typeof REQUIRED)[number], t: Tabular, ctx: ParseContext): ParserOutput {
  const L = layout(t, kind)!;
  const c = L.col;
  const trades: ClosedTrade[] = [];
  let skipped = 0;
  const cell = (r: Row, i: number) => (i >= 0 ? r[i] ?? '' : '');
  for (const r of L.rows.slice(L.headerIndex + 1)) {
    if (r.every((x) => x === '')) continue;
    const first = cell(r, c.id) || cell(r, c.open);
    // The closed-positions block ends at the first row that is not a numbered deal (totals, next section title).
    if (kind === 'mt4' ? !/^\d+$/.test(cell(r, c.id)) : !parseLocalDateTime(cell(r, c.open))) {
      if (first) break;
      continue;
    }
    // Cash movements, and pending orders that were deleted or cancelled without filling, are not trades.
    if (/^(balance|credit|deposit|withdrawal|correction|bonus)|\b(limit|stop)$/i.test(cell(r, c.type))) continue;
    const side = parseSide(cell(r, c.type));
    const open = parseLocalDateTime(cell(r, c.open));
    const close = parseLocalDateTime(cell(r, c.close));
    const lots = num(cell(r, c.size));
    const entry = num(cell(r, c.entry));
    const exit = num(cell(r, c.exit));
    const profit = num(cell(r, c.profit));
    if (!side || !open || !close || !lots || entry == null || exit == null || profit == null) {
      skipped++;
      continue;
    }
    const symbol = normalizeMtSymbol(cell(r, c.item));
    const costs = (num(cell(r, c.commission)) ?? 0) + (num(cell(r, c.taxes)) ?? 0) + (num(cell(r, c.swap)) ?? 0);
    const sl = num(cell(r, c.sl));
    const tp = num(cell(r, c.tp));
    trades.push({
      symbol, assetClass: mtAssetClass(symbol), contractMultiplier: contractSize(symbol), side, quantity: lots,
      entryPrice: entry, exitPrice: exit,
      openTime: toUtcIso(open, ctx.utcOffsetMinutes), closeTime: toUtcIso(close, ctx.utcOffsetMinutes),
      externalId: cell(r, c.id), grossProfit: profit, fees: -costs,
      stopLoss: sl && sl > 0 ? sl : null, takeProfit: tp && tp > 0 ? tp : null,
    });
  }
  if (trades.length) ctx.warnings.push('MetaTrader times are broker-server time. If your broker server is not on UTC, set the server UTC offset so open and close times are correct.');
  return { kind: 'closed', trades, skipped };
}

function mtParser(kind: (typeof REQUIRED)[number], name: string, howToExport: string, cols: string[], fileTypes: string[]): ImportParser {
  return {
    id: kind,
    name,
    assetClasses: ['forex', 'commodity', 'cfd', 'crypto'],
    fileTypes,
    howToExport,
    sampleColumns: cols,
    defaultUtcOffsetMinutes: 0,
    detect: (t) => (layout(t, kind) ? 20 : 0),
    parse: (t, ctx) => parseMt(kind, t, ctx),
  };
}

export const mt4 = mtParser(
  'mt4',
  'MetaTrader 4',
  'MT4 → Account History tab → right-click → All History (or a custom period) → right-click → Save as Detailed Report (HTML).',
  ['Ticket', 'Open Time', 'Type', 'Size', 'Item', 'Price', 'S / L', 'T / P', 'Close Time', 'Price', 'Commission', 'Taxes', 'Swap', 'Profit'],
  ['html', 'htm'],
);

export const mt5 = mtParser(
  'mt5',
  'MetaTrader 5',
  'MT5 → View → Toolbox → History → right-click → Report → HTML or Excel (XLSX) → save. The Positions table is read.',
  ['Time', 'Position', 'Symbol', 'Type', 'Volume', 'Price', 'S / L', 'T / P', 'Time', 'Price', 'Commission', 'Swap', 'Profit'],
  ['html', 'htm', 'xlsx'],
);
