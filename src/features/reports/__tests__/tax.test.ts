import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import type { AppEnv, Entitlements } from '../../../app/types';
import { fakeQuota, trade, tradeSource } from '../../__tests__/helpers';
import { reportsApp } from '../routes';
import { buildTaxReport, fyRange } from '../tax';

const d = (iso: string) => `${iso}T04:00:00.000Z`;
const t = (p: Parameters<typeof trade>[0]) => trade({ stopLoss: null, closeDate: p.closeDate ?? p.openDate, ...p });

const fixture = [
  t({ id: 'intra', assetClass: 'stock', side: 'BUY', quantity: 10, entryPrice: 100, exitPrice: 110, pnl: 95, fees: 5, openDate: d('2026-05-04'), closeDate: '2026-05-04T09:00:00.000Z' }),
  t({ id: 'stcg', assetClass: 'stock', side: 'BUY', quantity: 10, entryPrice: 100, exitPrice: 121, pnl: 200, fees: 10, openDate: d('2026-05-04'), closeDate: d('2026-09-01') }),
  t({ id: 'ltcg', assetClass: 'stock', side: 'BUY', quantity: 10, entryPrice: 100, exitPrice: 200, pnl: 1000, fees: 0, openDate: d('2025-05-01'), closeDate: d('2026-06-10') }),
  t({ id: 'opt1', assetClass: 'options', side: 'BUY', quantity: 75, entryPrice: 100, exitPrice: 120, pnl: 1440, fees: 60, openDate: d('2026-07-10'), closeDate: '2026-07-10T09:00:00.000Z' }),
  t({ id: 'opt2', assetClass: 'options', side: 'SELL', quantity: 75, entryPrice: 50, exitPrice: 40, pnl: 695, fees: 55, openDate: d('2026-07-11'), closeDate: '2026-07-11T09:00:00.000Z' }),
  t({ id: 'fut', assetClass: 'futures', side: 'BUY', quantity: 75, entryPrice: 24000, exitPrice: 24010, pnl: 660, fees: 90, openDate: d('2026-08-03'), closeDate: '2026-08-03T09:00:00.000Z' }),
  t({ id: 'fx', assetClass: 'forex', pnl: -40, fees: 0, openDate: d('2026-08-04') }),
  t({ id: 'out', assetClass: 'stock', pnl: 999, fees: 0, openDate: d('2027-04-02') }),
];

describe('fyRange', () => {
  it('accepts consecutive years only', () => {
    expect(fyRange('2026-27')).toEqual({ from: '2026-04-01', to: '2027-03-31' });
    expect(fyRange('2099-00')).toEqual({ from: '2099-04-01', to: '2100-03-31' });
    for (const bad of ['2026-28', '2026', '26-27', '', '2026-2027', '1999-00']) expect(fyRange(bad)).toBeNull();
  });
});

describe('buildTaxReport', () => {
  const r = buildTaxReport(fixture, '2026-27', null);

  it('splits intraday equity, F&O and delivery by holding period', () => {
    expect(r.intradayEquity).toEqual({ trades: 1, wins: 1, losses: 0, grossPnl: 100, fees: 5, netPnl: 95 });
    expect(r.delivery.shortTerm).toMatchObject({ trades: 1, grossPnl: 210, fees: 10, netPnl: 200 });
    expect(r.delivery.longTerm).toMatchObject({ trades: 1, grossPnl: 1000, netPnl: 1000 });
    expect(r.fno).toMatchObject({ trades: 3, grossPnl: 3000, fees: 205, netPnl: 2795 });
  });

  it('F&O turnover = |profits and losses| + premium on the sale leg of options', () => {
    // opt1: 1,500 + 120×75; opt2: 750 + 50×75 (sold first); fut: 750
    expect(r.fno.turnover).toBe(1500 + 9000 + 750 + 3750 + 750);
    expect(r.fno.auditThresholdExceeded).toBe(false);
    expect(buildTaxReport([t({ assetClass: 'futures', pnl: 60_000_000, fees: 0, openDate: d('2026-05-04') })], '2026-27', null).fno.auditThresholdExceeded).toBe(false);
    expect(buildTaxReport([t({ assetClass: 'futures', pnl: 120_000_000, fees: 0, openDate: d('2026-05-04') })], '2026-27', null).fno.auditThresholdExceeded).toBe(true);
  });

  it('ignores trades closed outside the FY and reports uncovered classes', () => {
    expect(r.notCovered).toEqual({ trades: 1, netPnl: -40 });
    const all = r.intradayEquity.trades + r.delivery.shortTerm.trades + r.delivery.longTerm.trades + r.fno.trades + r.commodity.trades + r.notCovered.trades;
    expect(all).toBe(7);
  });

  it('an FY boundary uses the IST date of the close', () => {
    const lastDay = t({ id: 'e', assetClass: 'stock', pnl: 10, fees: 0, openDate: '2027-03-31T10:00:00.000Z', closeDate: '2027-03-31T18:00:00.000Z' }); // 23:30 IST on 31 Mar → in FY
    const next = t({ id: 'n', assetClass: 'stock', pnl: 10, fees: 0, openDate: '2027-03-31T10:00:00.000Z', closeDate: '2027-03-31T19:00:00.000Z' }); // 00:30 IST on 1 Apr → next FY
    const rep = buildTaxReport([lastDay, next], '2026-27', null);
    expect(rep.intradayEquity.trades + rep.delivery.shortTerm.trades).toBe(1);
  });

  it('charges: statutory parts use the dated rates, the rest is brokerage/GST/other', () => {
    const one = buildTaxReport([fixture[3]], '2026-27', null);
    expect(one.charges.stt).toBe(13.5); // 0.15% of the 9,000 sell premium (rate from 2026-04-01)
    expect(one.charges.exchange).toBe(5.78); // 0.03503% × (7,500 + 9,000)
    expect(Math.abs(one.charges.stamp - 0.225)).toBeLessThan(0.01);
    expect(one.charges.total).toBe(60);
    const sum = one.charges.stt + one.charges.exchange + one.charges.sebi + one.charges.stamp + one.charges.brokerageGstAndOther;
    expect(sum).toBeCloseTo(60, 1);
    expect(r.charges.total).toBe(220);
  });

  it('warns that these are estimates and mentions the turnover method', () => {
    expect(r.warnings.join(' ')).toMatch(/chartered accountant/);
    expect(r.warnings.join(' ')).toMatch(/ICAI/);
    expect(buildTaxReport([fixture[3]], '2026-27', null).warnings.join(' ')).not.toMatch(/fees may be missing/);
  });

  it('says so when the recorded fees are below the statutory estimate (the parts then exceed the total)', () => {
    const noFees = buildTaxReport([{ ...fixture[3], fees: 0, pnl: 1500 }], '2026-27', null);
    expect(noFees.charges.total).toBe(0);
    expect(noFees.charges.stt).toBe(13.5);
    expect(noFees.warnings.join(' ')).toMatch(/fees recorded on these trades \(₹0\.00\) are less than the statutory charges estimated at these rates \(₹19\.\d\d\)/);
  });
});

function app(features: Partial<Entitlements['features']>, source = tradeSource(fixture)) {
  const a = new Hono<AppEnv>();
  a.use('*', async (c, next) => {
    c.set('userId', 'u1');
    c.set('quota', fakeQuota().quota);
    c.set('entitlements', { plan: features.tax_report ? 'pro' : 'free', status: 'active', limits: { ai_extract: 5, ai_insight: 1, ai_chat: 10, broker_import: 3, ai_enhance: 20 }, features: { advanced_analytics: false, tax_report: false, unlimited_accounts: false, auto_sync: false, ...features } });
    await next();
  });
  a.route('/', reportsApp({ trades: source }));
  return a;
}

describe('GET /reports/tax', () => {
  it('Free plan → 402 PLAN_REQUIRED tax_report', async () => {
    const res = await app({}).request('/tax?fy=2026-27');
    expect(res.status).toBe(402);
    expect(await res.json()).toMatchObject({ success: false, errorCode: 'PLAN_REQUIRED', error: { code: 'PLAN_REQUIRED', feature: 'tax_report', plan: 'free', requiredPlan: 'pro' } });
  });

  it('Pro plan → the report; the lookback reaches trades opened before the FY', async () => {
    const res = await app({ tax_report: true }).request('/tax?fy=2026-27');
    expect(res.status).toBe(200);
    const { data } = (await res.json()) as any;
    expect(data.report.delivery.longTerm.trades).toBe(1);
    expect(data.report.fno.turnover).toBe(15750);
  });

  it('a delivery position opened years before the lookback and closed in the FY is included (BE-046)', async () => {
    const old = { ...fixture[0], id: 'old-holding', accountId: 'a1', symbol: 'INFY', side: 'BUY' as const, quantity: 10, entryPrice: 1000, exitPrice: 1600, pnl: 6000, fees: 0, assetClass: 'stock', openDate: '2024-01-10T04:30:00.000Z', closeDate: '2026-06-01T05:00:00.000Z' };
    const source = tradeSource([...fixture, old]);
    const res = await app({ tax_report: true }, source).request('/tax?fy=2026-27');
    const longTerm = ((await res.json()) as any).data.report.delivery.longTerm;
    expect(longTerm.trades).toBe(2);
    expect(longTerm.netPnl).toBeGreaterThanOrEqual(6000);
  });

  it('both queries keep only trades that count in the FY, before the cap counts them, so trades closed elsewhere cannot cause a 422', async () => {
    const seen: any[] = [];
    const source = { ...tradeSource(fixture), async loadTrades(_u: string, r: any) { seen.push(r); return { trades: [], truncated: false }; } };
    await app({ tax_report: true }, source as any).request('/tax?fy=2026-27');
    expect(seen).toHaveLength(2);
    expect(seen[0]).toMatchObject({ from: '2025-02-25', to: '2027-03-31' });
    expect(seen[1]).toMatchObject({ from: '2016-04-01', to: '2025-02-24' });
    for (const { filter } of seen) {
      expect(filter({ openDate: '2024-01-10T04:00:00.000Z', closeDate: '2026-06-01T05:00:00.000Z' })).toBe(true);
      expect(filter({ openDate: '2026-05-04T04:00:00.000Z', closeDate: '2026-05-04T09:00:00.000Z' })).toBe(true);
      expect(filter({ openDate: '2026-05-04T04:00:00.000Z', closeDate: null })).toBe(true);
      expect(filter({ openDate: '2025-05-04T04:00:00.000Z', closeDate: '2025-06-01T05:00:00.000Z' })).toBe(false);
      expect(filter({ openDate: '2026-12-04T04:00:00.000Z', closeDate: '2027-04-02T05:00:00.000Z' })).toBe(false);
      expect(filter({ openDate: '2025-05-04T04:00:00.000Z', closeDate: null })).toBe(false);
    }
  });

  it('truncated trade data → 422 DATA_TRUNCATED with the reason, no report', async () => {
    const res = await app({ tax_report: true }, tradeSource(fixture, [], true)).request('/tax?fy=2026-27');
    expect(res.status).toBe(422);
    const j = (await res.json()) as any;
    expect(j).toMatchObject({ success: false, errorCode: 'DATA_TRUNCATED', error: { code: 'DATA_TRUNCATED', limit: 5000 } });
    expect(j.message).toMatch(/more than 5000 trades.*incomplete/);
    expect(j.data).toBeUndefined();
  });

  it('soft-deleted trades are the repository’s job; the report counts exactly what it is given', async () => {
    const res = await app({ tax_report: true }, tradeSource(fixture.slice(0, 1))).request('/tax?fy=2026-27');
    expect(((await res.json()) as any).data.report.intradayEquity.trades).toBe(1);
  });

  it('validates fy and filters by account', async () => {
    const pro = app({ tax_report: true });
    expect((await pro.request('/tax')).status).toBe(400);
    expect((await pro.request('/tax?fy=2026-28')).status).toBe(400);
    const none = (await (await pro.request('/tax?fy=2026-27&accountId=other')).json()) as any;
    expect(none.data.report.fno.trades).toBe(0);
    expect(none.data.report.accountId).toBe('other');
  });
});
