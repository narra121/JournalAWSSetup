import { describe, expect, it } from 'vitest';
import { buildEpisodes } from '../roundtrip';
import type { Fill } from '../types';

let seq = 0;
const fill = (p: Partial<Fill> & Pick<Fill, 'side' | 'quantity' | 'price' | 'time'>): Fill => ({
  symbol: 'INFY',
  assetClass: 'stock',
  tradeId: `t${++seq}`,
  orderId: `o${seq}`,
  ...p,
});

describe('buildEpisodes', () => {
  it('simple intraday long', () => {
    const r = buildEpisodes([
      fill({ side: 'BUY', quantity: 10, price: 100, time: '2026-04-03T04:00:00.000Z' }),
      fill({ side: 'SELL', quantity: 10, price: 105, time: '2026-04-03T05:00:00.000Z' }),
    ]);
    expect(r.episodes).toHaveLength(1);
    const e = r.episodes[0];
    expect(e).toMatchObject({ side: 'BUY', quantity: 10, entryPrice: 100, exitPrice: 105, grossPoints: 50, fills: 2 });
    expect(e.legs.every((l) => l.kind === 'intraday')).toBe(true);
  });

  it('scale-in and partial exits stay one episode with VWAP prices', () => {
    const r = buildEpisodes([
      fill({ side: 'BUY', quantity: 10, price: 100, time: '2026-04-03T04:00:00.000Z' }),
      fill({ side: 'BUY', quantity: 10, price: 110, time: '2026-04-03T04:10:00.000Z' }),
      fill({ side: 'SELL', quantity: 5, price: 120, time: '2026-04-03T04:20:00.000Z' }),
      fill({ side: 'SELL', quantity: 15, price: 100, time: '2026-04-03T04:30:00.000Z' }),
    ]);
    expect(r.episodes).toHaveLength(1);
    const e = r.episodes[0];
    expect(e.quantity).toBe(20);
    expect(e.entryPrice).toBe(105);
    expect(e.exitPrice).toBe(105);
    expect(e.grossPoints).toBe(0);
    // FIFO: first 5 sold come from the 100 lot.
    expect(e.legs.slice(0, 2)).toMatchObject([{ side: 'BUY', quantity: 5, price: 100 }, { side: 'SELL', quantity: 5, price: 120 }]);
  });

  it('reversal splits the crossing fill into close + new episode', () => {
    const r = buildEpisodes([
      fill({ symbol: 'NIFTY26APRFUT', assetClass: 'futures', side: 'BUY', quantity: 75, price: 24000, time: '2026-04-03T04:00:00.000Z' }),
      fill({ symbol: 'NIFTY26APRFUT', assetClass: 'futures', side: 'SELL', quantity: 150, price: 24100, time: '2026-04-06T04:00:00.000Z' }),
      fill({ symbol: 'NIFTY26APRFUT', assetClass: 'futures', side: 'BUY', quantity: 75, price: 24050, time: '2026-04-07T04:00:00.000Z' }),
    ]);
    expect(r.episodes.map((e) => [e.side, e.quantity, e.grossPoints])).toEqual([
      ['BUY', 75, 7500],
      ['SELL', 75, 3750],
    ]);
    expect(r.episodes[0].legs.every((l) => l.kind === 'fno')).toBe(true);
  });

  it('delivery vs intraday legs by FIFO lot date', () => {
    const r = buildEpisodes([
      fill({ side: 'BUY', quantity: 100, price: 50, time: '2026-04-06T04:00:00.000Z' }),
      fill({ side: 'SELL', quantity: 50, price: 51, time: '2026-04-06T08:00:00.000Z' }),
      fill({ side: 'SELL', quantity: 50, price: 52, time: '2026-04-07T05:00:00.000Z' }),
    ]);
    const kinds = r.episodes[0].legs.map((l) => `${l.side}:${l.quantity}:${l.kind}`);
    expect(kinds).toEqual(['BUY:50:intraday', 'SELL:50:intraday', 'BUY:50:delivery', 'SELL:50:delivery']);
  });

  it('equity sell from flat across days = pre-file holdings (unmatched), intraday short kept', () => {
    const r = buildEpisodes([
      fill({ symbol: 'TCS', side: 'SELL', quantity: 5, price: 4000, time: '2026-04-06T04:00:00.000Z' }),
      fill({ symbol: 'SBIN', side: 'SELL', quantity: 10, price: 800, time: '2026-04-06T04:00:00.000Z' }),
      fill({ symbol: 'SBIN', side: 'BUY', quantity: 10, price: 790, time: '2026-04-06T09:00:00.000Z' }),
    ]);
    expect(r.unmatchedFills).toBe(1);
    expect(r.episodes).toHaveLength(1);
    expect(r.episodes[0]).toMatchObject({ side: 'SELL', grossPoints: 100 });
    expect(r.episodes[0].instrument.symbol).toBe('SBIN');
  });

  it('open position at end is skipped and counted', () => {
    const r = buildEpisodes([fill({ symbol: 'HDFCBANK', side: 'BUY', quantity: 1, price: 1600, time: '2026-04-06T04:00:00.000Z' })]);
    expect(r.episodes).toHaveLength(0);
    expect(r.openPositions).toBe(1);
  });

  it('bought option past expiry closes at 0 when the file runs beyond expiry', () => {
    const opt = { symbol: 'NIFTY2640724000CE', assetClass: 'options' as const, expiry: '2026-04-07', optionType: 'call' as const };
    const r = buildEpisodes([
      fill({ ...opt, side: 'BUY', quantity: 75, price: 40, time: '2026-04-06T04:00:00.000Z' }),
      fill({ side: 'BUY', quantity: 1, price: 10, time: '2026-04-09T04:00:00.000Z' }),
    ]);
    const e = r.episodes.find((x) => x.instrument.symbol === opt.symbol)!;
    expect(e).toMatchObject({ expiredWorthless: true, exitPrice: 0, grossPoints: -3000 });
    expect(r.expiredClosed).toBe(1);
    expect(r.openPositions).toBe(1);
  });

  it('same-ISIN fills on NSE and BSE form one position', () => {
    const r = buildEpisodes([
      fill({ isin: 'INE009A01021', exchange: 'NSE', side: 'BUY', quantity: 2, price: 1500, time: '2026-04-06T04:00:00.000Z' }),
      fill({ isin: 'INE009A01021', exchange: 'BSE', side: 'SELL', quantity: 2, price: 1510, time: '2026-04-08T04:00:00.000Z' }),
    ]);
    expect(r.episodes).toHaveLength(1);
    expect(r.episodes[0].grossPoints).toBe(20);
  });
});
