import type { Row } from '../csv';
import { cellGetter, findHeaderRow, num, parseLocalDateTime, toUtcIso } from '../table';
import { parseIndianSymbol } from '../symbols';
import type { AssetClass, BrokerPlan, Fill, ImportParser, ParseContext, ParserOutput, SourceId, Tabular } from '../types';

interface FillConfig {
  id: SourceId;
  plan: BrokerPlan;
  name: string;
  howToExport: string;
  fileTypes: string[];
  sampleColumns: string[];
  /** normalised headers that must all be present (identifies the broker) */
  signature: string[];
  symbol: string[];
  side: string[];
  quantity: string[];
  price: string[];
  /** total traded value; price = value / quantity when the file has no price column */
  value?: string[];
  tradeId: string[];
  orderId: string[];
  dateTime: string[];
  date: string[];
  time: string[];
  exchange: string[];
  segment: string[];
  isin: string[];
  /** rows whose status cell matches are not executions */
  status?: string[];
}

export function parseSide(v: string): 'BUY' | 'SELL' | null {
  const s = v.trim().toLowerCase();
  if (/^(b|buy|bought|long)$/.test(s)) return 'BUY';
  if (/^(s|sell|sold|short)$/.test(s)) return 'SELL';
  return null;
}

const NOT_EXECUTED = /reject|cancel|pending|open|expired|failed/i;

function rowFill(cfg: FillConfig, get: ReturnType<typeof cellGetter>, ctx: ParseContext, seq: Map<string, number>): Fill | 'skip' {
  const status = cfg.status ? get(...cfg.status) : '';
  if (status && NOT_EXECUTED.test(status)) return 'skip';
  const rawSymbol = get(...cfg.symbol);
  const side = parseSide(get(...cfg.side));
  const quantity = num(get(...cfg.quantity));
  let price = num(get(...cfg.price));
  if (price == null && cfg.value && quantity) {
    const v = num(get(...cfg.value));
    if (v != null) price = v / quantity;
  }
  if (!rawSymbol || !side || !quantity || quantity <= 0 || price == null || price < 0) return 'skip';

  const dt = get(...cfg.dateTime);
  const local =
    (dt && /\d[-/. ][A-Za-z0-9]{1,3}[-/. ]\d/.test(dt) ? parseLocalDateTime(dt) : null) ??
    parseLocalDateTime(get(...cfg.date) || dt, get(...cfg.time) || (dt && !/\d[-/. ]\d/.test(dt) ? dt : ''));
  if (!local) return 'skip';

  const exchange = get(...cfg.exchange).toUpperCase() || undefined;
  const instrument = parseIndianSymbol(rawSymbol, exchange, get(...cfg.segment));
  const isin = get(...cfg.isin) || undefined;
  const orderId = get(...cfg.orderId) || undefined;
  let tradeId = get(...cfg.tradeId);
  if (!tradeId) {
    const k = orderId ?? `${rawSymbol}|${side}`;
    const n = (seq.get(k) ?? 0) + 1;
    seq.set(k, n);
    tradeId = `${k}#${n}`;
  }
  return { ...instrument, isin, side, quantity, price, time: toUtcIso(local, ctx.utcOffsetMinutes), tradeId, orderId };
}

export function makeFillParser(cfg: FillConfig): ImportParser {
  const find = (t: Tabular) => {
    for (const s of t.sheets) {
      const m = findHeaderRow(s.rows, cfg.signature);
      if (m) return { m, rows: s.rows };
    }
    return null;
  };
  return {
    id: cfg.id,
    name: cfg.name,
    assetClasses: ['stock', 'futures', 'options', 'commodity'] as AssetClass[],
    fileTypes: cfg.fileTypes,
    howToExport: cfg.howToExport,
    sampleColumns: cfg.sampleColumns,
    defaultUtcOffsetMinutes: 330,
    detect: (t) => (find(t) ? 10 + cfg.signature.length : 0),
    parse(t, ctx): ParserOutput {
      const fills: Fill[] = [];
      const seen = new Set<string>();
      const seq = new Map<string, number>();
      let skipped = 0;
      for (const sheet of t.sheets) {
        const m = findHeaderRow(sheet.rows, cfg.signature);
        if (!m) continue;
        for (const row of sheet.rows.slice(m.index + 1) as Row[]) {
          if (row.every((c) => c === '')) continue;
          const f = rowFill(cfg, cellGetter(m, row), ctx, seq);
          if (f === 'skip') {
            skipped++;
            continue;
          }
          const key = `${f.exchange ?? ''}|${f.tradeId}`;
          if (seen.has(key)) {
            skipped++;
            continue;
          }
          seen.add(key);
          fills.push(f);
        }
      }
      return { kind: 'fills', fills, skipped, plan: cfg.plan };
    },
  };
}

export const zerodha = makeFillParser({
  id: 'zerodha',
  plan: 'zerodha',
  name: 'Zerodha (Console tradebook)',
  fileTypes: ['csv', 'xlsx'],
  howToExport: 'Console → Reports → Tradebook → choose the segment and date range (max 365 days) → download CSV or XLSX.',
  sampleColumns: ['symbol', 'isin', 'trade_date', 'exchange', 'segment', 'series', 'trade_type', 'quantity', 'price', 'trade_id', 'order_id', 'order_execution_time'],
  signature: ['symbol', 'trade type', 'trade id', 'order id'],
  symbol: ['symbol'], side: ['trade type'], quantity: ['quantity'], price: ['price'],
  tradeId: ['trade id'], orderId: ['order id'], dateTime: ['order execution time'], date: ['trade date'], time: [],
  exchange: ['exchange'], segment: ['segment'], isin: ['isin'],
});

export const dhan = makeFillParser({
  id: 'dhan',
  plan: 'dhan',
  name: 'Dhan',
  fileTypes: ['csv', 'xlsx'],
  howToExport: 'Dhan web → Reports → Trade History → choose the date range → download.',
  sampleColumns: ['Date', 'Time', 'Name', 'Buy/Sell', 'Exchange', 'Segment', 'Quantity/Lot', 'Trade Price', 'Order No', 'Trade No'],
  signature: ['name', 'buy sell', 'trade price', 'trade no'],
  symbol: ['name', 'symbol'], side: ['buy sell'], quantity: ['quantity lot', 'quantity', 'qty'], price: ['trade price'],
  tradeId: ['trade no'], orderId: ['order no'], dateTime: ['trade time', 'time'], date: ['date', 'trade date'], time: ['time', 'trade time'],
  exchange: ['exchange'], segment: ['segment'], isin: ['isin'], status: ['status'],
});

export const upstox = makeFillParser({
  id: 'upstox',
  plan: 'upstox',
  name: 'Upstox',
  fileTypes: ['csv', 'xlsx'],
  howToExport: 'Upstox app or web → Reports → Trade Report (Tradebook) → choose the segment and date range → download.',
  sampleColumns: ['Scrip Name', 'Symbol', 'Trade Num', 'Trade Date', 'Trade Time', 'Exchange', 'Segment', 'Side', 'Qty', 'Price', 'Order Num'],
  signature: ['trade num', 'scrip name'],
  symbol: ['symbol', 'scrip name'], side: ['side', 'buy sell', 'trade type'], quantity: ['qty', 'quantity'], price: ['price', 'trade price'],
  tradeId: ['trade num'], orderId: ['order num', 'order id'], dateTime: [], date: ['trade date', 'date'], time: ['trade time', 'time'],
  exchange: ['exchange'], segment: ['segment'], isin: ['isin'],
});

export const angelone = makeFillParser({
  id: 'angelone',
  plan: 'angelone',
  name: 'Angel One',
  fileTypes: ['csv', 'xlsx'],
  howToExport: 'Angel One web → Reports → Trade History (or Tradebook) → choose the date range → download.',
  sampleColumns: ['Trade No', 'Order No', 'Symbol', 'Exchange', 'Segment', 'Transaction Type', 'Quantity', 'Trade Price', 'Trade Date', 'Trade Time'],
  signature: ['trade no', 'transaction type', 'trade price'],
  symbol: ['symbol', 'scrip name'], side: ['transaction type'], quantity: ['quantity', 'qty'], price: ['trade price'],
  tradeId: ['trade no'], orderId: ['order no'], dateTime: [], date: ['trade date', 'date'], time: ['trade time', 'time'],
  exchange: ['exchange'], segment: ['segment'], isin: ['isin'],
});

export const groww = makeFillParser({
  id: 'groww',
  plan: 'groww',
  name: 'Groww',
  fileTypes: ['xlsx', 'csv'],
  howToExport: 'Groww → Profile → Reports → Order History (Stocks or F&O) → choose the date range → download.',
  sampleColumns: ['Stock name', 'Symbol', 'ISIN', 'Type', 'Quantity', 'Value', 'Exchange', 'Exchange Order Id', 'Executed date and time', 'Order status'],
  signature: ['exchange order id', 'executed date and time'],
  symbol: ['symbol', 'stock name'], side: ['type', 'side'], quantity: ['quantity', 'qty'], price: ['price'], value: ['value'],
  tradeId: ['trade id'], orderId: ['exchange order id'], dateTime: ['executed date and time'], date: [], time: [],
  exchange: ['exchange'], segment: ['segment'], isin: ['isin'], status: ['order status', 'status'],
});
