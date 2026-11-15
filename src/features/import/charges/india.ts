import type { Charges, Instrument } from '../types';
import type { Episode, Leg } from '../roundtrip';
import { istDate } from '../table';

/**
 * Indian statutory charges + broker brokerage plans. Rates are looked up by the TRADE DATE (IST) so old trades
 * use the rates in force then. Everything produced here is an ESTIMATE: the contract note is authoritative.
 * Add a row when a rate changes; each row cites the circular it comes from. Brokerage plans come from broker pricing pages.
 */
export type Segment = 'delivery' | 'intraday' | 'futures' | 'options' | 'commodity';
export type Plan = 'zerodha' | 'dhan' | 'upstox' | 'angelone' | 'groww';

type PerSegment<T> = Record<Segment, T>;
interface Rates {
  effectiveFrom: string;
  /** STT: fraction of traded value on the listed side */
  stt: PerSegment<{ buy: number; sell: number }>;
  /** STT on an exercised option: fraction of its intrinsic value at expiry, paid by the buyer */
  sttExercise: number;
  /** exchange transaction charge, fraction of traded value */
  exchange: PerSegment<{ nse: number; bse: number }>;
  /** NSE Investor Protection Fund Trust contribution, fraction of traded value; outside the GST base (no source puts GST on it) */
  ipft: PerSegment<number>;
  sebi: number;
  /** stamp duty, buy side */
  stamp: PerSegment<number>;
  gst: number;
}

// Up to 2023-03-31: futures 0.01%, options 0.05% (https://nsearchives.nseindia.com/content/circulars/FATAX32385.pdf, 16 May 2016;
// the "upto March 31, 2023" column of FATAX56235). Exercised options 0.125% in both.
const STT_2016: Rates['stt'] = {
  delivery: { buy: 0.001, sell: 0.001 },
  intraday: { buy: 0, sell: 0.00025 },
  futures: { buy: 0, sell: 0.0001 },
  options: { buy: 0, sell: 0.0005 },
  commodity: { buy: 0, sell: 0.0001 },
};
const BASE_STT: Rates['stt'] = { ...STT_2016, futures: { buy: 0, sell: 0.000125 }, options: { buy: 0, sell: 0.000625 } };
const STAMP: Rates['stamp'] = { delivery: 0.00015, intraday: 0.00003, futures: 0.00002, options: 0.00003, commodity: 0.00002 };
const EXCH_2020: Rates['exchange'] = {
  delivery: { nse: 0.0000325, bse: 0.0000375 },
  intraday: { nse: 0.0000325, bse: 0.0000375 },
  futures: { nse: 0.00002, bse: 0 },
  options: { nse: 0.0005, bse: 0.0005 },
  commodity: { nse: 0.000026, bse: 0.000026 },
};
const EXCH_2024: Rates['exchange'] = {
  delivery: { nse: 0.0000297, bse: 0.0000375 },
  intraday: { nse: 0.0000297, bse: 0.0000375 },
  futures: { nse: 0.0000173, bse: 0 },
  options: { nse: 0.0003503, bse: 0.000325 },
  commodity: { nse: 0.000026, bse: 0.000026 },
};
// NSE Rs 306.99 cash / 182.99 futures / 3,552.99 options per crore (https://nsearchives.nseindia.com/content/circulars/FA73061.pdf, 27 Feb 2026).
const EXCH_2026: Rates['exchange'] = {
  ...EXCH_2024,
  delivery: { nse: 0.000030699, bse: 0.0000375 },
  intraday: { nse: 0.000030699, bse: 0.0000375 },
  futures: { nse: 0.000018299, bse: 0 },
  options: { nse: 0.000355299, bse: 0.000325 },
};
const NO_IPFT: Rates['ipft'] = { delivery: 0, intraday: 0, futures: 0, options: 0, commodity: 0 };
// Rs 10 per crore cash and futures, Rs 50 per crore options (https://nsearchives.nseindia.com/content/circulars/FA56129.pdf, 24 Mar 2023).
const IPFT_2023: Rates['ipft'] = { ...NO_IPFT, delivery: 0.000001, intraday: 0.000001, futures: 0.000001, options: 0.000005 };
// Rs 0.01 per crore (FA73061, 27 Feb 2026).
const IPFT_2026: Rates['ipft'] = { ...NO_IPFT, delivery: 1e-9, intraday: 1e-9, futures: 1e-9, options: 1e-9 };
const STT_2024: Rates['stt'] = { ...BASE_STT, futures: { buy: 0, sell: 0.0002 }, options: { buy: 0, sell: 0.001 } };

export const RATE_TABLE: Rates[] = [
  { effectiveFrom: '2020-07-01', stt: STT_2016, sttExercise: 0.00125, exchange: EXCH_2020, ipft: NO_IPFT, sebi: 0.000001, stamp: STAMP, gst: 0.18 },
  // STT futures 0.0125%, options 0.0625% (https://nsearchives.nseindia.com/content/circulars/FATAX56235.pdf, 1 Apr 2023); IPFT FA56129.
  { effectiveFrom: '2023-04-01', stt: BASE_STT, sttExercise: 0.00125, exchange: EXCH_2020, ipft: IPFT_2023, sebi: 0.000001, stamp: STAMP, gst: 0.18 },
  // STT futures 0.02%, options 0.1% (https://nsearchives.nseindia.com/content/circulars/FATAX63809.pdf, 9 Sep 2024);
  // NSE charges https://nsearchives.nseindia.com/content/circulars/FA64232.pdf (27 Sep 2024).
  { effectiveFrom: '2024-10-01', stt: STT_2024, sttExercise: 0.00125, exchange: EXCH_2024, ipft: IPFT_2023, sebi: 0.000001, stamp: STAMP, gst: 0.18 },
  // NSE transaction charge and IPFT revised (FA73061, 27 Feb 2026).
  { effectiveFrom: '2026-03-01', stt: STT_2024, sttExercise: 0.00125, exchange: EXCH_2026, ipft: IPFT_2026, sebi: 0.000001, stamp: STAMP, gst: 0.18 },
  {
    // STT futures 0.05%, options 0.15%, exercised 0.15% (https://nsearchives.nseindia.com/content/circulars/FATAX73524.pdf, 31 Mar 2026).
    effectiveFrom: '2026-04-01',
    stt: { ...BASE_STT, futures: { buy: 0, sell: 0.0005 }, options: { buy: 0, sell: 0.0015 } },
    sttExercise: 0.0015,
    exchange: EXCH_2026,
    ipft: IPFT_2026,
    sebi: 0.000001,
    stamp: STAMP,
    gst: 0.18,
  },
];

export function ratesFor(dateIst: string): Rates {
  let r = RATE_TABLE[0];
  for (const row of RATE_TABLE) if (row.effectiveFrom <= dateIst) r = row;
  return r;
}

/** Brokerage for one executed order of `value` turnover. */
export function brokerage(plan: Plan, segment: Segment, value: number): number {
  const lowerOf = (pct: number, flat: number) => Math.min(value * pct, flat);
  const fno = (pct: number) => (segment === 'options' ? 20 : lowerOf(pct, 20));
  switch (plan) {
    case 'zerodha':
    case 'dhan':
      return segment === 'delivery' ? 0 : segment === 'intraday' ? lowerOf(0.0003, 20) : fno(0.0003);
    case 'upstox':
      return segment === 'delivery' ? lowerOf(0.025, 20) : segment === 'intraday' ? lowerOf(0.001, 20) : fno(0.001);
    case 'angelone':
      return segment === 'delivery' ? 0 : segment === 'intraday' ? lowerOf(0.001, 20) : fno(0.001);
    case 'groww':
      return segment === 'delivery' || segment === 'intraday' ? Math.max(5, lowerOf(0.001, 20)) : fno(0.001);
  }
}

const r2 = (x: number) => Math.round((x + Number.EPSILON) * 100) / 100;
const zero = (): Charges => ({ brokerage: 0, stt: 0, exchange: 0, sebi: 0, stamp: 0, gst: 0, other: 0 });

export function segmentOf(inst: Pick<Instrument, "assetClass">, kind: Leg["kind"]): Segment {
  if (inst.assetClass === 'options') return 'options';
  if (inst.assetClass === 'commodity') return 'commodity';
  if (inst.assetClass === 'futures') return 'futures';
  return kind === 'delivery' ? 'delivery' : 'intraday';
}

/** Estimated for NSE/BSE cash, NSE/BSE F&O and MCX. Currency derivatives and other classes are not. */
export function canEstimate(inst: Instrument): boolean {
  const ex = (inst.exchange || '').toUpperCase();
  const ok = inst.assetClass === 'stock' || inst.assetClass === 'options' || inst.assetClass === 'futures' || inst.assetClass === 'commodity';
  return ok && !/CDS|BCD/.test(ex);
}

/**
 * Charges per episode (null when not estimable). Brokerage is per executed order: orders are totalled across all
 * episodes of the file, then each leg takes its share by turnover. Statutory charges use each leg's own value.
 * `other` is the NSE IPFT contribution. Exercise STT is not included: no import path marks an exercised option.
 */
export function estimateCharges(episodes: Episode[], plan: Plan): (Charges | null)[] {
  const key = (e: Episode, l: Leg) => `${e.instrument.symbol}|${l.orderId}|${istDate(l.time)}|${l.side}`;
  const orderValue = new Map<string, number>();
  for (const e of episodes) for (const l of e.legs) orderValue.set(key(e, l), (orderValue.get(key(e, l)) ?? 0) + l.quantity * l.price);

  return episodes.map((e) => {
    if (!canEstimate(e.instrument)) return null;
    const c = zero();
    const bse = /BSE|BFO/.test((e.instrument.exchange || '').toUpperCase());
    for (const l of e.legs) {
      const value = l.quantity * l.price;
      const seg = segmentOf(e.instrument, l.kind);
      const rates = ratesFor(istDate(l.time));
      const total = orderValue.get(key(e, l)) ?? value;
      const brok = total > 0 ? brokerage(plan, seg, total) * (value / total) : 0;
      const exch = value * (bse ? rates.exchange[seg].bse : rates.exchange[seg].nse);
      const sebi = value * rates.sebi;
      c.brokerage += brok;
      c.stt += value * rates.stt[seg][l.side === 'BUY' ? 'buy' : 'sell'];
      c.exchange += exch;
      c.sebi += sebi;
      c.other += bse ? 0 : value * rates.ipft[seg];
      c.stamp += l.side === 'BUY' ? value * rates.stamp[seg] : 0;
      c.gst += (brok + exch + sebi) * rates.gst;
    }
    for (const k of Object.keys(c) as (keyof Charges)[]) c[k] = r2(c[k]);
    return c;
  });
}

export const totalCharges = (c: Charges) => r2(c.brokerage + c.stt + c.exchange + c.sebi + c.stamp + c.gst + c.other);
