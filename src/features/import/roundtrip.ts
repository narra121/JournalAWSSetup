import type { Charges, Fill, Instrument } from './types';
import { istDate } from './table';

/** One leg of a FIFO-matched lot: what charges are computed on. */
export interface Leg {
  side: 'BUY' | 'SELL';
  quantity: number;
  price: number;
  time: string;
  orderId: string;
  /** Equity: same-IST-day open and close → intraday, else delivery. Derivatives: 'fno'. */
  kind: 'intraday' | 'delivery' | 'fno';
  /** this leg's share of the charges its fill carried (Fill.charges); absent when the file lists none */
  charges?: Charges;
}

export interface Episode {
  instrument: Instrument;
  side: 'BUY' | 'SELL';
  quantity: number;
  entryPrice: number;
  exitPrice: number;
  openTime: string;
  closeTime: string;
  /** Σ sell value − Σ buy value, in price units × quantity (multiplier not applied) */
  grossPoints: number;
  firstFillId: string;
  lastFillId: string;
  fills: number;
  legs: Leg[];
  /** Closed synthetically at price 0 on expiry (option with no closing fill). */
  expiredWorthless?: boolean;
}

export interface RoundTripResult {
  episodes: Episode[];
  /** closing quantity with no opening fill in the file (position opened before the file's first date) */
  unmatchedFills: number;
  /** positions still open at the end of the file (skipped) */
  openPositions: number;
  expiredClosed: number;
}

interface Lot {
  qty: number;
  price: number;
  time: string;
  orderId: string;
  /** the opening fill's charges and quantity, so each closed part takes its share */
  charges?: Charges;
  fillQty: number;
}

const CHARGE_KEYS = ['brokerage', 'stt', 'exchange', 'sebi', 'stamp', 'gst', 'other'] as const;

function shareOf(c: Charges | undefined, part: number, whole: number): Charges | undefined {
  if (!c) return undefined;
  const out = {} as Charges;
  for (const k of CHARGE_KEYS) out[k] = (c[k] * part) / whole;
  return out;
}

interface Open {
  side: 'BUY' | 'SELL';
  lots: Lot[];
  openQty: number;
  openValue: number;
  closeQty: number;
  closeValue: number;
  openTime: string;
  lastTime: string;
  firstFillId: string;
  lastFillId: string;
  fillIds: Set<string>;
  legs: Leg[];
  instrument: Instrument;
}

const EPS = 1e-9;

function positionKey(f: Fill): string {
  const family = f.assetClass === 'stock' ? 'EQ' : f.assetClass;
  return `${family}|${f.isin || f.symbol.toUpperCase()}`;
}

/**
 * Groups fills into position episodes (flat → flat) per instrument, matching closing quantity to opening lots
 * FIFO. Scale-ins and partial exits stay in one episode; a fill that crosses zero is split (reversal).
 * Equity sells from flat that are not bought back the same IST day are treated as sales of holdings bought
 * before the file (unmatched), because Indian cash-market shorts must be squared off intraday.
 */
export function buildEpisodes(fills: Fill[], asOf?: string): RoundTripResult {
  const sorted = fills
    .map((f, i) => ({ f, i }))
    .sort((a, b) => (a.f.time < b.f.time ? -1 : a.f.time > b.f.time ? 1 : a.i - b.i))
    .map((x) => x.f);
  // An open bought option counts as expired only if the file itself runs past its expiry date.
  const fileEnd = asOf ?? sorted[sorted.length - 1]?.time ?? '';

  const open = new Map<string, Open>();
  const episodes: Episode[] = [];
  let unmatchedFills = 0;
  let openPositions = 0;
  let expiredClosed = 0;

  const finish = (key: string, o: Open, extra?: Partial<Episode>) => {
    open.delete(key);
    episodes.push({
      instrument: o.instrument,
      side: o.side,
      quantity: round6(o.openQty),
      entryPrice: round6(o.openValue / o.openQty),
      exitPrice: round6(o.closeQty > 0 ? o.closeValue / o.closeQty : 0),
      openTime: o.openTime,
      closeTime: o.lastTime,
      grossPoints: o.side === 'BUY' ? o.closeValue - o.openValue : o.openValue - o.closeValue,
      firstFillId: o.firstFillId,
      lastFillId: o.lastFillId,
      fills: o.fillIds.size,
      legs: o.legs,
      ...extra,
    });
  };

  for (const f of sorted) {
    const key = positionKey(f);
    let qty = f.quantity;
    // An equity sell from flat that was not covered on its own IST day was a sale of holdings bought before the file:
    // it is dropped now, so a later buy of the same stock opens a position instead of "closing" that sale.
    const stale = open.get(key);
    if (stale && f.assetClass === 'stock' && stale.side === 'SELL' && istDate(stale.openTime) < istDate(f.time)) {
      unmatchedFills += stale.fillIds.size;
      open.delete(key);
    }
    const cur = open.get(key);

    if (cur && cur.side !== f.side) {
      // Closing (possibly reversing) fill: consume lots FIFO.
      while (qty > EPS && cur.lots.length) {
        const lot = cur.lots[0];
        const take = Math.min(lot.qty, qty);
        const kind: Leg['kind'] = f.assetClass === 'stock' ? (istDate(lot.time) === istDate(f.time) ? 'intraday' : 'delivery') : 'fno';
        cur.legs.push(
          { side: cur.side, quantity: take, price: lot.price, time: lot.time, orderId: lot.orderId, kind, charges: shareOf(lot.charges, take, lot.fillQty) },
          { side: f.side, quantity: take, price: f.price, time: f.time, orderId: f.orderId ?? f.tradeId, kind, charges: shareOf(f.charges, take, f.quantity) },
        );
        cur.closeQty += take;
        cur.closeValue += take * f.price;
        lot.qty -= take;
        qty -= take;
        if (lot.qty <= EPS) cur.lots.shift();
      }
      cur.lastTime = f.time;
      cur.lastFillId = f.tradeId;
      cur.fillIds.add(f.tradeId);
      if (!cur.lots.length) finish(key, cur);
      if (qty <= EPS) continue;
    }

    const o = open.get(key);
    if (o) {
      o.lots.push({ qty, price: f.price, time: f.time, orderId: f.orderId ?? f.tradeId, charges: f.charges, fillQty: f.quantity });
      o.openQty += qty;
      o.openValue += qty * f.price;
      o.lastTime = f.time;
      o.lastFillId = f.tradeId;
      o.fillIds.add(f.tradeId);
    } else {
      const { side: _s, quantity: _q, price: _p, time: _t, tradeId: _id, orderId: _o, charges: _c, ...instrument } = f;
      open.set(key, {
        side: f.side,
        lots: [{ qty, price: f.price, time: f.time, orderId: f.orderId ?? f.tradeId, charges: f.charges, fillQty: f.quantity }],
        openQty: qty,
        openValue: qty * f.price,
        closeQty: 0,
        closeValue: 0,
        openTime: f.time,
        lastTime: f.time,
        firstFillId: f.tradeId,
        lastFillId: f.tradeId,
        fillIds: new Set([f.tradeId]),
        legs: [],
        instrument,
      });
    }
  }

  // Equity "shorts" never covered on their opening day were sales of pre-file holdings.
  for (const [key, o] of [...open]) {
    if (o.instrument.assetClass === 'stock' && o.side === 'SELL') {
      unmatchedFills += o.fillIds.size;
      open.delete(key);
    }
  }
  // Episodes that were closed but began as an uncovered equity short across days are also holdings sales.
  for (let i = episodes.length - 1; i >= 0; i--) {
    const e = episodes[i];
    if (e.instrument.assetClass === 'stock' && e.side === 'SELL' && istDate(e.openTime) !== istDate(e.closeTime)) {
      unmatchedFills += e.fills;
      episodes.splice(i, 1);
    }
  }

  for (const [key, o] of [...open]) {
    const expiry = o.instrument.expiry;
    if (o.instrument.assetClass === 'options' && o.side === 'BUY' && expiry && expiry < istDate(fileEnd)) {
      const closeTime = `${expiry}T10:00:00.000Z`;
      for (const lot of o.lots) {
        o.legs.push({ side: 'BUY', quantity: lot.qty, price: lot.price, time: lot.time, orderId: lot.orderId, kind: 'fno', charges: shareOf(lot.charges, lot.qty, lot.fillQty) });
      }
      o.lots = [];
      o.closeQty = o.openQty;
      o.lastTime = closeTime;
      expiredClosed++;
      finish(key, o, { expiredWorthless: true });
    } else {
      openPositions++;
    }
  }

  episodes.sort((a, b) => (a.openTime < b.openTime ? -1 : a.openTime > b.openTime ? 1 : 0));
  return { episodes, unmatchedFills, openPositions, expiredClosed };
}

function round6(x: number): number {
  return Math.round(x * 1e6) / 1e6;
}
