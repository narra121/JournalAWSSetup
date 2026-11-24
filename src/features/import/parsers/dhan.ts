import { cellGetter, findHeaderRow, num, parseLocalDateTime, toUtcIso } from '../table';
import { parseIndianSymbol } from '../symbols';
import type { Charges, Fill, ImportParser, ParserOutput, Tabular } from '../types';
import { dhanTradeHistory } from './fills';

const GTR = ['scrip name', 'bill no', 'buy qty', 'buy value', 'sell qty', 'sell value'];

function findGtr(t: Tabular) {
  for (const s of t.sheets) {
    const m = findHeaderRow(s.rows, GTR);
    if (m) return { m, rows: s.rows };
  }
  return null;
}

const pad = (n: number) => String(n).padStart(2, '0');

/** The row's charge columns (Gross Amount = Sell Value − Buy Value − these). */
function rowCharges(get: ReturnType<typeof cellGetter>): Charges {
  const n = (...names: string[]) => num(get(...names)) ?? 0;
  return { brokerage: n('brokerage'), stt: n('stt'), exchange: n('txn charges'), sebi: n('sebi fees'), stamp: n('stamp duty'), gst: n('gst'), other: n('oth charges') };
}

function scaled(c: Charges, f: number): Charges {
  return { brokerage: c.brokerage * f, stt: c.stt * f, exchange: c.exchange * f, sebi: c.sebi * f, stamp: c.stamp * f, gst: c.gst * f, other: c.other * f };
}

/**
 * Dhan does not let users download executions; its Global Transaction Report has one row per contract per bill (day)
 * with that day's buy and sell totals. Each row becomes a BUY fill and a SELL fill at the day's average prices, timed
 * at midnight of the day (BUY first), so round trips are built the same way as for other brokers. The row's charges are
 * split between its two fills by traded value.
 */
export const dhan: ImportParser = {
  ...dhanTradeHistory,
  name: 'Dhan',
  fileTypes: ['csv'],
  howToExport: 'Dhan → Journal → Global Transactions → choose the period → download CSV. Dhan does not offer a download of individual trades, so each day is imported from its buy and sell totals.',
  sampleColumns: ['Date', 'Scrip Name', 'Exchange', 'Bill No.', 'Buy Qty.', 'Buy Value', 'Sell Qty.', 'Sell Value', 'Brokerage', 'GST', 'STT', 'SEBI Fees', 'Stamp Duty', 'Txn. Charges', 'Oth. Charges', 'Gross Amount'],
  detect: (t) => (findGtr(t) ? 10 + GTR.length : dhanTradeHistory.detect(t)),
  parse(t, ctx): ParserOutput {
    const g = findGtr(t);
    if (!g) return dhanTradeHistory.parse(t, ctx);
    const fills: Fill[] = [];
    let skipped = 0;
    for (const row of g.rows.slice(g.m.index + 1)) {
      if (row.every((c) => c === '')) continue;
      const get = cellGetter(g.m, row);
      const scrip = get('scrip name');
      const buyQty = num(get('buy qty')) ?? 0;
      const sellQty = num(get('sell qty')) ?? 0;
      const day = parseLocalDateTime(get('date'));
      // The totals and note lines under the table have no quantities and are not counted.
      if (!day || !scrip) {
        if (buyQty > 0 || sellQty > 0) skipped++;
        continue;
      }
      const exchange = get('exchange').toUpperCase() || undefined;
      const instrument = parseIndianSymbol(scrip, exchange);
      const time = toUtcIso({ ...day, h: 0, mi: 0, s: 0 }, ctx.utcOffsetMinutes);
      const id = `${get('bill no')}|${scrip.toUpperCase()}|${day.y}-${pad(day.mo)}-${pad(day.d)}`;
      const buyValue = num(get('buy value'));
      const sellValue = num(get('sell value'));
      const buy = buyQty > 0 && buyValue != null && buyValue >= 0;
      const sell = sellQty > 0 && sellValue != null && sellValue >= 0;
      const charges = rowCharges(get);
      const total = (buy ? buyValue! : 0) + (sell ? sellValue! : 0);
      const part = (v: number) => scaled(charges, total > 0 ? v / total : buy && sell ? 0.5 : 1);
      let used = false;
      if (buy) {
        fills.push({ ...instrument, side: 'BUY', quantity: buyQty, price: buyValue! / buyQty, time, tradeId: `${id}|B`, charges: part(buyValue!) });
        used = true;
      }
      if (sell) {
        fills.push({ ...instrument, side: 'SELL', quantity: sellQty, price: sellValue! / sellQty, time, tradeId: `${id}|S`, charges: part(sellValue!) });
        used = true;
      }
      if (!used) skipped++;
    }
    if (fills.length) {
      ctx.warnings.push("Dhan's Global Transaction Report has each day's buy and sell totals but no trade times: trades are dated by day at average prices, and one contract's trades on one day are combined.");
    }
    return { kind: 'fills', fills, skipped, plan: 'dhan' };
  },
};
