import { pipSize } from '../pnl';
import { parseLocalDateTime } from './table';
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
  if ((m = SPACED_CONTRACT.exec(symbol)) && MONTHS[m[4] ?? m[5]] && (m[1] === 'OPT') === (m[9] != null)) {
    const c = contractInstrument({
      underlying: m[2], expiry: `${m[7]}-${pad(MONTHS[m[4] ?? m[5]])}-${pad(+(m[3] ?? m[6]))}`, exchange,
      optionType: m[9] === 'CE' ? 'call' : m[9] === 'PE' ? 'put' : undefined, strike: m[8] != null ? +m[8] : undefined,
    });
    if (c) return c;
  }
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

/**
 * Contract names written out in words: Angel One "OPTIDX NIFTY AUG 25 2026 24150.00 PE (BT)", "BSXOPT SENSEX …",
 * "FUTSTK …"; Dhan "OPT NIFTY 07 APR 2026 23000 CE", "FUT WIPRO 28 APR 2026". Groups: 1 OPT/FUT, 2 underlying,
 * 3+4 day-first or 5+6 month-first expiry, 7 year, 8 strike, 9 CE/PE.
 */
const SPACED_CONTRACT = /^(?:BSX)?(OPT|FUT)[A-Z]{0,3}\s+([A-Z0-9&-]+)\s+(?:(\d{1,2})\s+([A-Z]{3})|([A-Z]{3})\s+(\d{1,2}))\s+(\d{4})(?:\s+(\d+(?:\.\d+)?)\s+(CE|PE))?\b/;

/**
 * Option or future from its parts, with one symbol for every broker that spells contracts out:
 * "NIFTY 25 AUG 2026 24150 PE", "WIPRO 28 APR 2026 FUT". `expiry` is ISO or day-first (01-09-2026).
 * Null when the expiry or, for an option, the strike cannot be read.
 */
export function contractInstrument(c: { underlying: string; expiry: string; optionType?: 'call' | 'put'; strike?: number; exchange?: string }): Instrument | null {
  const e = parseLocalDateTime(c.expiry);
  const underlying = c.underlying.trim().toUpperCase();
  if (!e || !underlying) return null;
  const expiry = `${e.y}-${pad(e.mo)}-${pad(e.d)}`;
  const when = `${pad(e.d)} ${MONTH_NAMES[e.mo - 1]} ${e.y}`;
  const mcx = /MCX/.test((c.exchange || '').toUpperCase());
  if (c.optionType) {
    if (c.strike == null || !(c.strike > 0)) return null;
    const right = c.optionType === 'call' ? 'CE' : 'PE';
    return { symbol: `${underlying} ${when} ${c.strike} ${right}`, exchange: c.exchange, assetClass: 'options', underlying, optionType: c.optionType, strike: c.strike, expiry };
  }
  return { symbol: `${underlying} ${when} FUT`, exchange: c.exchange, assetClass: mcx ? 'commodity' : 'futures', underlying, expiry };
}

const MONTH_NAMES = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];

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
