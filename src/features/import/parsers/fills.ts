import type { Row } from '../csv';
import { cellGetter, findHeaderRow, num, parseLocalDateTime, toUtcIso, type DateOrder } from '../table';
import { contractInstrument, parseIndianSymbol } from '../symbols';
import type { AssetClass, BrokerPlan, Fill, ImportParser, Instrument, ParseContext, ParserOutput, SourceId, Tabular } from '../types';

type Getter = ReturnType<typeof cellGetter>;

interface FillConfig {
  id: SourceId;
  plan: BrokerPlan;
  name: string;
  howToExport: string;
  fileTypes: string[];
  sampleColumns: string[];
  /** normalised headers that must all be present (identifies the broker) */
  signature: string[];
  /** other header sets that identify the same report (another layout or export vintage) */
  altSignatures?: string[][];
  symbol: string[];
  side: string[];
  quantity: string[];
  price: string[];
  /** price columns split by side (the other side's cell is empty); read when `price` finds nothing */
  buyPrice?: string[];
  sellPrice?: string[];
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
  /** order of numeric dates such as 11/5/26; default day first */
  dateOrder?: DateOrder;
  /** exchange codes the broker prints for derivatives segments → exchange */
  exchangeMap?: Record<string, string>;
  /** contract built from several columns; null = read from the symbol cell */
  instrument?: (get: Getter, exchange: string | undefined) => Instrument | null;
  /** added to the warnings when the file yields fills */
  note?: string;
  /** the file has no times and does not list same-day fills in order: fills that share a timestamp are ordered by
   *  numeric trade id (exchange trade numbers rise through the day) */
  orderByTradeId?: boolean;
}

const byTradeId = (a: Fill, b: Fill) => {
  if (a.time !== b.time) return a.time < b.time ? -1 : 1;
  if (!/^\d+$/.test(a.tradeId) || !/^\d+$/.test(b.tradeId)) return 0;
  const x = BigInt(a.tradeId), y = BigInt(b.tradeId);
  return x < y ? -1 : x > y ? 1 : 0;
};

/** A clock at the end of a date cell (an XLSX date reads as "2026-08-28 00:00:00"). */
const CLOCK_SUFFIX = /[T ]\d{1,2}:\d{2}(?::\d{2})?(?:\.\d+)?\s*(?:[AaPp][Mm])?$/;

export function parseSide(v: string): 'BUY' | 'SELL' | null {
  const s = v.trim().toLowerCase();
  if (/^(b|buy|bought|long)$/.test(s)) return 'BUY';
  if (/^(s|sell|sold|short)$/.test(s)) return 'SELL';
  return null;
}

const NOT_EXECUTED = /reject|cancel|pending|open|expired|failed/i;

function rowFill(cfg: FillConfig, get: Getter, ctx: ParseContext, seq: Map<string, number>): Fill | 'skip' {
  const status = cfg.status ? get(...cfg.status) : '';
  if (status && NOT_EXECUTED.test(status)) return 'skip';
  const rawSymbol = get(...cfg.symbol);
  const side = parseSide(get(...cfg.side));
  const quantity = num(get(...cfg.quantity));
  let price = num(get(...cfg.price));
  if (price == null && side) price = num(get(...((side === 'BUY' ? cfg.buyPrice : cfg.sellPrice) ?? [])));
  if (price == null && cfg.value && quantity) {
    const v = num(get(...cfg.value));
    if (v != null) price = v / quantity;
  }
  if (!rawSymbol || !side || !quantity || quantity <= 0 || price == null || price < 0) return 'skip';

  const dt = get(...cfg.dateTime);
  const time = get(...cfg.time) || (dt && !/\d[-/. ]\d/.test(dt) ? dt : '');
  const date = get(...cfg.date) || dt;
  const local =
    (dt && /\d[-/. ][A-Za-z0-9]{1,3}[-/. ]\d/.test(dt) ? parseLocalDateTime(dt, '', cfg.dateOrder) : null) ??
    parseLocalDateTime(time ? date.replace(CLOCK_SUFFIX, '') : date, time, cfg.dateOrder);
  if (!local) return 'skip';

  const printed = get(...cfg.exchange).toUpperCase();
  const exchange = cfg.exchangeMap?.[printed] ?? (printed || undefined);
  const instrument = cfg.instrument?.(get, exchange) ?? parseIndianSymbol(rawSymbol, exchange, get(...cfg.segment));
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
  const signatures = [cfg.signature, ...(cfg.altSignatures ?? [])];
  const headerOf = (rows: Row[]) => {
    for (const sig of signatures) {
      const m = findHeaderRow(rows, sig);
      if (m) return { m, size: sig.length };
    }
    return null;
  };
  const find = (t: Tabular) => {
    for (const s of t.sheets) {
      const h = headerOf(s.rows);
      if (h) return h;
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
    detect: (t) => {
      const h = find(t);
      return h ? 10 + h.size : 0;
    },
    parse(t, ctx): ParserOutput {
      const fills: Fill[] = [];
      const seen = new Set<string>();
      const seq = new Map<string, number>();
      let skipped = 0;
      for (const sheet of t.sheets) {
        const m = headerOf(sheet.rows)?.m;
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
      if (cfg.orderByTradeId) fills.sort(byTradeId);
      if (cfg.note && fills.length) ctx.warnings.push(cfg.note);
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

/** Dhan fill layout from before the Global Transaction Report was found; kept for files that match it (parsers/dhan.ts). */
export const dhanTradeHistory = makeFillParser({
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

/** Upstox prints SENSEX contracts under the code BSX. */
const UPSTOX_UNDERLYING: Record<string, string> = { BSX: 'SENSEX' };

export const upstox = makeFillParser({
  id: 'upstox',
  plan: 'upstox',
  name: 'Upstox',
  fileTypes: ['csv', 'xlsx'],
  howToExport: 'Upstox web (account.upstox.com) → Reports → Trade → choose the segment and period → Download (XLSX).',
  sampleColumns: ['Date', 'Company', 'Amount', 'Exchange', 'Segment', 'Scrip Code', 'Instrument Type', 'Strike Price', 'Expiry', 'Trade Num', 'Trade Time', 'Side', 'Quantity', 'Price'],
  signature: ['trade num', 'trade time', 'scrip code', 'instrument type'],
  altSignatures: [['trade num', 'scrip name']],
  symbol: ['symbol', 'scrip name', 'company'], side: ['side', 'buy sell', 'trade type'], quantity: ['qty', 'quantity'], price: ['price', 'trade price'],
  tradeId: ['trade num'], orderId: ['order num', 'order id'], dateTime: [], date: ['trade date', 'date'], time: ['trade time', 'time'],
  exchange: ['exchange'], segment: ['segment'], isin: ['isin'],
  exchangeMap: { FON: 'NSE', FOB: 'BSE' },
  // F&O rows name the underlying in Scrip Code and spread the contract over Instrument Type, Strike Price and Expiry.
  instrument: (get, exchange) => {
    const type = get('instrument type');
    if (!/call|put|fut/i.test(type)) return null;
    const underlying = get('scrip code') || get('company');
    return contractInstrument({
      underlying: UPSTOX_UNDERLYING[underlying.toUpperCase()] ?? underlying,
      expiry: get('expiry'),
      optionType: /call/i.test(type) ? 'call' : /put/i.test(type) ? 'put' : undefined,
      strike: num(get('strike price')) ?? undefined,
      exchange,
    });
  },
});

export const angelone = makeFillParser({
  id: 'angelone',
  plan: 'angelone',
  name: 'Angel One',
  fileTypes: ['csv', 'xlsx'],
  howToExport: 'Angel One app → Account → Trades and charges → choose the date range → Download trade history (XLSX). The file has trade dates but no times.',
  sampleColumns: ['Scrip/Contract', 'Buy/Sell', 'Buy Price', 'Sell Price', 'Quantity', 'Brokerage', 'Order Type', 'Segment', 'Exchange', 'Order ID', 'Trade ID', 'Date'],
  signature: ['scrip contract', 'buy sell', 'trade id', 'order id'],
  altSignatures: [['trade no', 'transaction type', 'trade price']],
  symbol: ['symbol', 'scrip name', 'scrip contract'], side: ['transaction type', 'buy sell'], quantity: ['quantity', 'qty'], price: ['trade price'],
  buyPrice: ['buy price'], sellPrice: ['sell price'],
  tradeId: ['trade no', 'trade id'], orderId: ['order no', 'order id'], dateTime: [], date: ['trade date', 'date'], time: ['trade time', 'time'],
  exchange: ['exchange'], segment: ['segment'], isin: ['isin'],
  // A CSV saved from the trade history writes dates as 11/5/26 0:00 (month first).
  dateOrder: 'mdy',
  orderByTradeId: true,
  note: 'Angel One trade history has dates but no times: trades are timed at midnight of their day, and fills of one day are taken in trade-number order.',
});

export const groww = makeFillParser({
  id: 'groww',
  plan: 'groww',
  name: 'Groww',
  fileTypes: ['xlsx', 'csv'],
  howToExport: 'Groww → Profile → Reports → Order History (Stocks or F&O) → choose the date range → download.',
  sampleColumns: ['Stock name', 'Symbol', 'ISIN', 'Type', 'Quantity', 'Value', 'Exchange', 'Exchange Order Id', 'Execution date and time', 'Order status'],
  signature: ['exchange order id', 'execution date and time'],
  altSignatures: [['exchange order id', 'executed date and time']],
  symbol: ['symbol', 'stock name'], side: ['type', 'side'], quantity: ['quantity', 'qty'], price: ['price'], value: ['value'],
  tradeId: ['trade id'], orderId: ['exchange order id'], dateTime: ['execution date and time', 'executed date and time'], date: [], time: [],
  exchange: ['exchange'], segment: ['segment'], isin: ['isin'], status: ['order status', 'status'],
});
