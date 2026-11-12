import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { fakeQuota, memoryStore, post, tradeSource, withUser } from '../../__tests__/helpers';
import { brokerage, estimateCharges, ratesFor, totalCharges } from '../charges/india';
import { buildEpisodes } from '../roundtrip';
import { importApp, REPARSE_WINDOW_MS } from '../routes';
import { importKey } from '../service';
import type { Fill } from '../types';

const file = (n: string) => readFileSync(join(__dirname, '..', 'fixtures', n)).toString('base64');

function setup(opts: { limit?: number; imported?: string[]; clock?: { t: number } } = {}) {
  const clock = opts.clock ?? { t: Date.parse('2026-11-11T10:00:00Z') };
  const store = memoryStore();
  const q = fakeQuota({ broker_import: opts.limit ?? 3 });
  const app = withUser(importApp({ store, trades: tradeSource([], opts.imported), now: () => new Date(clock.t) }), 'u1', q.quota);
  return { app, q, store, clock };
}
const body = (name: string, extra: object = {}) => ({ source: 'auto', fileName: name, contentBase64: file(name), ...extra });

describe('GET /sources', () => {
  it('lists every source with export instructions', async () => {
    const { app } = setup();
    const { data } = (await (await app.request('/sources')).json()) as any;
    const ids = data.sources.map((s: any) => s.id);
    expect(ids).toEqual(expect.arrayContaining(['zerodha', 'dhan', 'upstox', 'angelone', 'groww', 'mt4', 'mt5', 'generic_csv', 'zerodha_pnl']));
    expect(data.sources.every((s: any) => s.howToExport && s.fileTypes.length && s.sampleColumns.length)).toBe(true);
  });
});

describe('POST /parse', () => {
  it('parses, wraps in the envelope and uses one import unit', async () => {
    const { app, q } = setup();
    const res = await post(app, '/parse', body('zerodha.csv'));
    expect(res.status).toBe(200);
    const j = (await res.json()) as any;
    expect(j.success).toBe(true);
    expect(j.data.detectedSource).toBe('zerodha');
    expect(j.data.trades).toHaveLength(3);
    expect(j.data.fileHash).toBeUndefined();
    expect(q.used.broker_import).toBe(1);
  });

  it('costs nothing when the file is unknown or yields no trades', async () => {
    const { app, q } = setup();
    const res = await post(app, '/parse', { source: 'auto', fileName: 'x.csv', contentBase64: Buffer.from('a,b\n1,2\n').toString('base64') });
    expect(((await res.json()) as any).data).toMatchObject({ detectedSource: 'unknown', trades: [] });
    expect(q.calls).toHaveLength(0);
  });

  it('402 with the contract shape and no trades when the quota is used up', async () => {
    const { app } = setup({ limit: 0 });
    const res = await post(app, '/parse', body('dhan.csv'));
    expect(res.status).toBe(402);
    const j = (await res.json()) as any;
    expect(j).toMatchObject({ success: false, errorCode: 'QUOTA_EXCEEDED', error: { feature: 'broker_import', limit: 0 } });
    expect(j.data).toBeUndefined();
  });

  it('BE-R13: the same file re-parsed within 30 minutes (other account/mapping) is free; after the window it costs again', async () => {
    const { app, q, clock } = setup();
    await post(app, '/parse', body('upstox.csv', { accountId: 'acc1' }));
    clock.t += REPARSE_WINDOW_MS - 1000;
    const again = await post(app, '/parse', body('upstox.csv', { accountId: 'acc2', utcOffsetMinutes: 330 }));
    expect(again.status).toBe(200);
    expect(q.used.broker_import).toBe(1);
    clock.t += 2000;
    await post(app, '/parse', body('upstox.csv', { accountId: 'acc1' }));
    expect(q.used.broker_import).toBe(2);
    await post(app, '/parse', body('dhan.csv'));
    expect(q.used.broker_import).toBe(3);
  });

  it('a different user does not share the free re-parse', async () => {
    const a = setup({ limit: 3 });
    await post(a.app, '/parse', body('mt4.html'));
    const b = fakeQuota({ broker_import: 3 });
    const app2 = withUser(importApp({ store: a.store, trades: tradeSource([]), now: () => new Date('2026-11-11T10:05:00Z') }), 'u2', b.quota);
    await post(app2, '/parse', body('mt4.html'));
    expect(b.used.broker_import).toBe(1);
  });

  it('marks trades already imported into the account', async () => {
    const first = await post(setup().app, '/parse', body('angelone.csv'));
    const trades = ((await first.json()) as any).data.trades;
    const { app } = setup({ imported: [importKey('acc1', trades[0])] });
    const j = (await (await post(app, '/parse', body('angelone.csv', { accountId: 'acc1' }))).json()) as any;
    expect(j.data.duplicates).toBe(1);
    expect(j.data.trades.filter((t: any) => t.duplicate)).toHaveLength(1);
    expect(j.data.warnings.join(' ')).toMatch(/already imported/);
    expect(importKey('acc1', trades[0])).toBe(`imp|acc1|angelone|${trades[0].externalId}`);
  });

  it('returns a mapping step for an unrecognised generic csv and no quota use', async () => {
    const { app, q } = setup();
    const csv = Buffer.from('Foo,Bar,Baz\n1,2,3\n').toString('base64');
    const j = (await (await post(app, '/parse', { source: 'generic_csv', fileName: 'g.csv', contentBase64: csv })).json()) as any;
    expect(j.data.columns.headers).toEqual(['Foo', 'Bar', 'Baz']);
    expect(j.data.trades).toEqual([]);
    expect(q.calls).toHaveLength(0);
  });

  it.each([
    [{ source: 'nope', fileName: 'a', contentBase64: 'QQ==' }],
    [{ source: 'auto', fileName: '', contentBase64: 'QQ==' }],
    [{ source: 'auto', fileName: 'a' }],
    [{ source: 'auto', fileName: 'a', contentBase64: 'QQ==', utcOffsetMinutes: 9999 }],
    [{ source: 'auto', fileName: 'a', contentBase64: 'QQ==', mapping: { evil: 'x' } }],
    [{ source: 'auto', fileName: 'a', contentBase64: 'QQ==', accountId: 5 }],
  ])('400 for invalid body %#', async (b) => {
    expect((await post(setup().app, '/parse', b)).status).toBe(400);
  });

  it('413 above the size limit', async () => {
    const res = await post(setup().app, '/parse', { source: 'auto', fileName: 'big.csv', contentBase64: 'A'.repeat(5_600_001) });
    expect(res.status).toBe(413);
  });
});

describe('India charges', () => {
  const f = (p: Partial<Fill> & Pick<Fill, 'side' | 'quantity' | 'price' | 'time'>): Fill => ({ symbol: 'NIFTY2641324000CE', assetClass: 'options', exchange: 'NSE', tradeId: p.time + p.side, orderId: p.time + p.side, ...p });
  const optionsTrade = (day: string) =>
    buildEpisodes([f({ side: 'BUY', quantity: 75, price: 100, time: `${day}T04:00:00.000Z` }), f({ side: 'SELL', quantity: 75, price: 120, time: `${day}T05:00:00.000Z` })]).episodes;

  it('uses the rates in force on the trade date (STT on options sell premium)', () => {
    const stt = (day: string) => estimateCharges(optionsTrade(day), 'zerodha')[0]!.stt;
    expect(stt('2024-09-20')).toBe(5.63); // 0.0625% × 9,000 = 5.625
    expect(stt('2024-10-15')).toBe(9); // 0.1% × 9,000
    expect(stt('2026-04-08')).toBe(13.5); // 0.15% × 9,000
    expect(ratesFor('2019-01-01').effectiveFrom).toBe('2020-07-01');
  });

  it('brokerage per order follows each plan', () => {
    expect(brokerage('zerodha', 'delivery', 100000)).toBe(0);
    expect(brokerage('zerodha', 'intraday', 100000)).toBe(20);
    expect(brokerage('zerodha', 'intraday', 10000)).toBeCloseTo(3, 10);
    expect(brokerage('zerodha', 'options', 5000)).toBe(20);
    expect(brokerage('upstox', 'delivery', 400)).toBe(10);
    expect(brokerage('groww', 'delivery', 100)).toBe(5);
  });

  it('orders split across fills are charged once per order, shared by turnover', () => {
    const eps = buildEpisodes([
      f({ side: 'BUY', quantity: 75, price: 100, time: '2026-04-08T04:00:00.000Z', orderId: 'O1', tradeId: 'a' }),
      f({ side: 'BUY', quantity: 75, price: 100, time: '2026-04-08T04:00:01.000Z', orderId: 'O1', tradeId: 'b' }),
      f({ side: 'SELL', quantity: 150, price: 110, time: '2026-04-08T05:00:00.000Z', orderId: 'O2', tradeId: 'c' }),
    ]).episodes;
    expect(estimateCharges(eps, 'zerodha')[0]!.brokerage).toBe(40);
  });

  it('returns null for segments it cannot estimate and totals add up', () => {
    const cds = buildEpisodes([f({ symbol: 'USDINR', assetClass: 'futures', exchange: 'CDS', side: 'BUY', quantity: 1000, price: 83, time: '2026-04-08T04:00:00.000Z' }), f({ symbol: 'USDINR', assetClass: 'futures', exchange: 'CDS', side: 'SELL', quantity: 1000, price: 83.1, time: '2026-04-08T05:00:00.000Z' })]).episodes;
    expect(estimateCharges(cds, 'zerodha')).toEqual([null]);
    const c = estimateCharges(optionsTrade('2026-04-08'), 'zerodha')[0]!;
    expect(totalCharges(c)).toBeCloseTo(c.brokerage + c.stt + c.exchange + c.sebi + c.stamp + c.gst, 2);
  });
});
