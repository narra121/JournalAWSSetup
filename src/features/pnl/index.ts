// P&L engine. Same algorithm as TradeFlow src/lib/pnl/index.ts; both repos test against the identical
// vectors.json (hash-pinned in the tests) so the two implementations cannot drift silently.

export type Side = 'BUY' | 'SELL';

export interface PnlInput {
  side: Side;
  quantity: number;
  entryPrice: number;
  exitPrice: number;
  /** Lot size / point value / contract size. Default 1 (Indian tradebooks already report units). */
  multiplier?: number | null;
  /** Total costs in account currency (positive = cost). */
  fees?: number | null;
  /** Broker-reported gross profit (MT4/MT5); used instead of price math when present. */
  grossOverride?: number | null;
  stopLoss?: number | null;
}

export interface PnlResult {
  grossPnl: number;
  fees: number;
  netPnl: number;
  rMultiple: number | null;
}

/** Round to 2 decimals, half away from zero, never returns -0. */
export function round2(x: number): number {
  if (!Number.isFinite(x)) return 0;
  const r = (Math.sign(x) * Math.round((Math.abs(x) + Number.EPSILON) * 100)) / 100;
  return r === 0 ? 0 : r;
}

export function computePnl(input: PnlInput): PnlResult {
  const mult = input.multiplier && input.multiplier > 0 ? input.multiplier : 1;
  const sign = input.side === 'BUY' ? 1 : -1;
  const grossRaw =
    input.grossOverride != null && Number.isFinite(input.grossOverride)
      ? input.grossOverride
      : (input.exitPrice - input.entryPrice) * input.quantity * mult * sign;
  const grossPnl = round2(grossRaw);
  const fees = round2(input.fees ?? 0);
  const netPnl = round2(grossPnl - fees);
  return { grossPnl, fees, netPnl, rMultiple: rMultiple(input) };
}

/**
 * Realised R from prices: direction × (exit − entry) ÷ |entry − stop|, before fees (quantity and multiplier cancel out).
 * Null when there is no usable stop or no exit price. Same formula as the backend's /stats and analysis.
 */
export function rMultiple(t: { side: Side; entryPrice: number; exitPrice: number; stopLoss?: number | null }): number | null {
  const stop = t.stopLoss;
  if (stop == null || !(stop > 0) || stop === t.entryPrice || !Number.isFinite(t.exitPrice)) return null;
  return round2(((t.side === 'BUY' ? 1 : -1) * (t.exitPrice - t.entryPrice)) / Math.abs(t.entryPrice - stop));
}

const FX_CCY = new Set(['USD', 'EUR', 'GBP', 'JPY', 'CHF', 'AUD', 'NZD', 'CAD', 'SGD', 'HKD', 'NOK', 'SEK', 'DKK', 'ZAR', 'MXN', 'TRY', 'PLN', 'CNH', 'INR']);

/** Pip size for FX / metals symbols (suffixes like EURUSD.m, XAUUSDm are tolerated). Null for non-FX. */
export function pipSize(symbol: string): number | null {
  const s = symbol.toUpperCase().replace(/[^A-Z]/g, '');
  if (s.startsWith('XAU')) return 0.1;
  if (s.startsWith('XAG')) return 0.01;
  const base = s.slice(0, 3);
  const quote = s.slice(3, 6);
  if (s.length < 6 || !FX_CCY.has(base) || !FX_CCY.has(quote)) return null;
  return quote === 'JPY' ? 0.01 : 0.0001;
}

/** Outcome used across imports: by net P&L sign. */
export function outcomeFromPnl(netPnl: number): 'TP' | 'SL' | 'BREAKEVEN' {
  return netPnl > 0 ? 'TP' : netPnl < 0 ? 'SL' : 'BREAKEVEN';
}
