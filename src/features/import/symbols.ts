import { pipSize } from '../pnl';
import type { AssetClass, Instrument } from './types';

const MONTHS: Record<string, number> = { JAN: 1, FEB: 2, MAR: 3, APR: 4, MAY: 5, JUN: 6, JUL: 7, AUG: 8, SEP: 9, OCT: 10, NOV: 11, DEC: 12 };
const WEEKLY_MONTH: Record<string, number> = { '1': 1, '2': 2, '3': 3, '4': 4, '5': 5, '6': 6, '7': 7, '8': 8, '9': 9, O: 10, N: 11, D: 12 };

const pad = (n: number) => String(n).padStart(2, '0');
const lastDay = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate();

/**
 * Indian exchange symbol → instrument. Handles weekly options (NIFTY2640724000CE), monthly options
 * (NIFTY26APR24000CE), futures (NIFTY26APRFUT) and plain equities. Monthly contracts carry only year+month in
 * the symbol, so `expiry` is the month's last day (an upper bound; used only to decide a long option expired).
 */
export function parseIndianSymbol(raw: string, exchange?: string, segment?: string): Instrument {
  const symbol = raw.trim().toUpperCase();
  const mcx = /MCX/.test((exchange || '').toUpperCase()) || /^COM/.test((segment || '').toUpperCase());
  let m: RegExpExecArray | null;
  if ((m = /^([A-Z&-]+?)(\d{2})([A-Z]{3})(\d+(?:\.\d+)?)(CE|PE)$/.exec(symbol)) && MONTHS[m[3]]) {
    const y = 2000 + +m[2], mo = MONTHS[m[3]];
    return { symbol, exchange, assetClass: 'options', underlying: m[1], optionType: m[5] === 'CE' ? 'call' : 'put', strike: +m[4], expiry: `${y}-${pad(mo)}-${pad(lastDay(y, mo))}` };
  }
  if ((m = /^([A-Z&-]+?)(\d{2})([1-9OND])(\d{2})(\d+(?:\.\d+)?)(CE|PE)$/.exec(symbol))) {
    const y = 2000 + +m[2], mo = WEEKLY_MONTH[m[3]];
    return { symbol, exchange, assetClass: 'options', underlying: m[1], optionType: m[6] === 'CE' ? 'call' : 'put', strike: +m[5], expiry: `${y}-${pad(mo)}-${m[4]}` };
  }
  if ((m = /^([A-Z&-]+?)(\d{2})([A-Z]{3})FUT$/.exec(symbol)) && MONTHS[m[3]]) {
    const y = 2000 + +m[2], mo = MONTHS[m[3]];
    return { symbol, exchange, assetClass: mcx ? 'commodity' : 'futures', underlying: m[1], expiry: `${y}-${pad(mo)}-${pad(lastDay(y, mo))}` };
  }
  const seg = (segment || '').toUpperCase();
  const cls: AssetClass = /FO|FNO|NFO|BFO|CDS/.test(seg) ? 'futures' : 'stock';
  return { symbol, exchange, assetClass: cls };
}

/** MetaTrader symbol → canonical (EURUSD.m, EURUSD#, EURUSD_i, EURUSD.pro, EURUSDm → EURUSD). */
export function normalizeMtSymbol(raw: string): string {
  let s = raw.trim().toUpperCase().replace(/[.#_-].*$/, '');
  if (/^[A-Z]{7}$/.test(s) && 'MCZ'.includes(s[6]) && pipSize(s.slice(0, 6)) != null) s = s.slice(0, 6);
  return s;
}

const PRECIOUS = /^(XAU|XAG)/;
/** Contract size used for P&L when a MetaTrader report gives volume in lots and profit is not authoritative. */
export function mtAssetClass(symbol: string): AssetClass {
  const s = symbol.toUpperCase();
  if (/^(BTC|ETH|LTC|XRP|SOL|DOGE|ADA|BNB)/.test(s)) return 'crypto';
  if (PRECIOUS.test(s) || /^(XTI|XBR|USOIL|UKOIL|WTI|BRENT|GOLD|SILVER)/.test(s)) return 'commodity';
  if (/^(US30|US500|US100|NAS100|SPX500|GER40|DE40|UK100|JP225|DJ30|NDX|SPX|DAX|FTSE)/.test(s)) return 'cfd';
  return /^[A-Z]{6}$/.test(s) ? 'forex' : 'cfd';
}
