import type { Charges, Instrument } from '../types';
import type { Episode, Leg } from '../roundtrip';
import { istDate } from '../table';

/**
 * Indian statutory charges + broker brokerage plans. Rates are looked up by the TRADE DATE (IST) so old trades
 * use the rates in force then. Everything produced here is an ESTIMATE: the contract note is authoritative.
 * Add a row (never edit an old one) when a rate changes. Sources: exchange circulars, Union Budget 2024/2026
 * (STT hike effective 2026-04-01), broker pricing pages.
 */
export type Segment = 'delivery' | 'intraday' | 'futures' | 'options' | 'commodity';
export type Plan = 'zerodha' | 'dhan' | 'upstox' | 'angelone' | 'groww';

type PerSegment<T> = Record<Segment, T>;
interface Rates {
  effectiveFrom: string;
  /** STT: fraction of traded value on the listed side */
  stt: PerSegment<{ buy: number; sell: number }>;
  /** exchange transaction charge, fraction of traded value */
  exchange: PerSegment<{ nse: number; bse: number }>;
  sebi: number;
  /** stamp duty, buy side */
  stamp: PerSegment<number>;
  gst: number;
}

const BASE_STT: Rates['stt'] = {
  delivery: { buy: 0.001, sell: 0.001 },
  intraday: { buy: 0, sell: 0.00025 },
  futures: { buy: 0, sell: 0.000125 },
  options: { buy: 0, sell: 0.000625 },
  commodity: { buy: 0, sell: 0.0001 },
};
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

export const RATE_TABLE: Rates[] = [
  { effectiveFrom: '2020-07-01', stt: BASE_STT, exchange: EXCH_2020, sebi: 0.000001, stamp: STAMP, gst: 0.18 },
  {
    // Union Budget 2024: STT futures 0.02%, options premium 0.1%; NSE transaction charges revised.
    effectiveFrom: '2024-10-01',
    stt: { ...BASE_STT, futures: { buy: 0, sell: 0.0002 }, options: { buy: 0, sell: 0.001 } },
    exchange: EXCH_2024,
    sebi: 0.000001,
    stamp: STAMP,
    gst: 0.18,
  },
  {
    // Union Budget 2026-27: STT futures 0.05%, options premium 0.15% (effective 2026-04-01).
    effectiveFrom: '2026-04-01',
    stt: { ...BASE_STT, futures: { buy: 0, sell: 0.0005 }, options: { buy: 0, sell: 0.0015 } },
    exchange: EXCH_2024,
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
      c.stamp += l.side === 'BUY' ? value * rates.stamp[seg] : 0;
      c.gst += (brok + exch + sebi) * rates.gst;
    }
    for (const k of Object.keys(c) as (keyof Charges)[]) c[k] = r2(c[k]);
    return c;
  });
}

export const totalCharges = (c: Charges) => r2(c.brokerage + c.stt + c.exchange + c.sebi + c.stamp + c.gst + c.other);
