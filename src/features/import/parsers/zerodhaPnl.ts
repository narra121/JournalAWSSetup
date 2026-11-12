import { cellGetter, findHeaderRow, num, parseLocalDateTime, toUtcIso } from '../table';
import { parseIndianSymbol } from '../symbols';
import type { ClosedTrade, ImportParser } from '../types';

const SIGNATURE = ['symbol', 'isin', 'quantity', 'buy value', 'sell value'];

export const zerodhaPnl: ImportParser = {
  id: 'zerodha_pnl',
  name: 'Zerodha (Console P&L statement)',
  assetClasses: ['stock', 'futures', 'options'],
  fileTypes: ['xlsx', 'csv'],
  howToExport: 'Console → Reports → P&L → choose the segment and period → download. This is a per-symbol summary without trade times; the Tradebook gives full trades.',
  sampleColumns: ['Symbol', 'ISIN', 'Quantity', 'Buy Value', 'Sell Value', 'Realized P&L'],
  defaultUtcOffsetMinutes: 330,
  detect: (t) => (t.sheets.some((s) => findHeaderRow(s.rows, SIGNATURE)) ? 12 : 0),
  parse(t, ctx) {
    const trades: ClosedTrade[] = [];
    let skipped = 0;
    for (const s of t.sheets) {
      const m = findHeaderRow(s.rows, SIGNATURE);
      if (!m) continue;
      const preamble = s.rows.slice(0, m.index).flat().join(' ');
      const dates = [...preamble.matchAll(/\d{4}-\d{2}-\d{2}/g)].map((x) => x[0]);
      const from = dates[0];
      const to = dates[dates.length - 1] ?? from;
      const closeLocal = to ? parseLocalDateTime(to) : null;
      const openLocal = from ? parseLocalDateTime(from) : null;
      if (!closeLocal || !openLocal) {
        ctx.warnings.push('Could not find the statement period in the file; use the Tradebook instead.');
        continue;
      }
      for (const row of s.rows.slice(m.index + 1)) {
        const get = cellGetter(m, row);
        const symbol = get('symbol');
        const qty = num(get('quantity'));
        const buy = num(get('buy value'));
        const sell = num(get('sell value'));
        if (!symbol || !qty || qty <= 0 || buy == null || sell == null) {
          if (symbol) skipped++;
          continue;
        }
        trades.push({
          ...parseIndianSymbol(symbol, 'NSE', 'EQ'),
          side: 'BUY', quantity: qty, entryPrice: buy / qty, exitPrice: sell / qty,
          openTime: toUtcIso(openLocal, ctx.utcOffsetMinutes), closeTime: toUtcIso(closeLocal, ctx.utcOffsetMinutes),
          externalId: `${from}:${to}:${symbol}`, grossProfit: num(get('realized p l', 'profit')) ?? sell - buy,
        });
      }
    }
    if (trades.length) ctx.warnings.push('This statement is per-symbol for the whole period: one trade per symbol, dated by the period, with no charges. Use the Tradebook for per-trade detail.');
    return { kind: 'closed', trades, skipped };
  },
};
