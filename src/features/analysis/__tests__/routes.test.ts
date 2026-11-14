import { describe, expect, it } from 'vitest';
import { fakeQuota, post, withUser } from '../../__tests__/helpers';
import type { TradeRange, TradeRow, TradeSource } from '../../trades-repo';
import type { AccountInfo, AnalysisDeps } from '../load';
import { resolveTimeZone } from '../load';
import { analysisApp } from '../routes';
import { DETECTOR_IDS, DIMENSIONS } from '../types';
import { behaviourTrades, row } from './build';

const ACCOUNTS: AccountInfo[] = [
  { accountId: 'acc1', currency: 'INR', initialBalance: 100_000 },
  { accountId: 'acc2', currency: 'INR', initialBalance: 50_000 },
  { accountId: 'usd', currency: 'USD', initialBalance: null },
];

function setup(trades: TradeRow[] = behaviourTrades(), opts: { zone?: string | null; truncated?: boolean } = {}) {
  const ranges: TradeRange[] = [];
  const source: TradeSource = {
    async loadTrades(_u, r) {
      ranges.push(r);
      return { trades: trades.filter((t) => !r.accountId || t.accountId === r.accountId), truncated: !!opts.truncated };
    },
    async loadRuleTexts() {
      return new Map([['r1', 'No revenge trades']]);
    },
    async importedKeys() {
      return new Set();
    },
  };
  const deps: AnalysisDeps = { trades: source, accounts: async () => ACCOUNTS, timeZone: async () => (opts.zone === undefined ? 'Asia/Kolkata' : opts.zone) };
  return { app: withUser(analysisApp(deps), 'u1', fakeQuota().quota), ranges };
}
const json = async (r: Response) => (await r.json()) as any;

describe('GET /analysis', () => {
  it('returns every Analysis field for one account, in the user’s time zone', async () => {
    const { app, ranges } = setup();
    const res = await app.request('/?accountId=acc1&from=2026-03-01&to=2026-03-31');
    expect(res.status).toBe(200);
    const { analysis } = (await json(res)).data;
    expect(Object.keys(analysis).sort()).toEqual(['bridge', 'concentration', 'currency', 'detectors', 'edge', 'label', 'period', 'risk', 'rolling', 'scenario', 'segments', 'timing', 'tradeCount', 'truncated'].sort());
    expect(analysis).toMatchObject({ currency: 'INR', tradeCount: 12, truncated: false, period: { from: '2026-03-01', to: '2026-03-31', timeZone: 'Asia/Kolkata' } });
    expect(Object.keys(analysis.segments).sort()).toEqual([...DIMENSIONS].sort());
    expect(analysis.detectors.map((d: any) => d.id)).toEqual([...DETECTOR_IDS]);
    expect(analysis.risk.riskPerTrade.medianShareOfBalance).toBe(0.0004);
    expect(ranges[0]).toEqual({ from: '2026-03-01', to: '2026-03-31', timeZone: 'Asia/Kolkata', accountId: 'acc1' });
  });

  it('a daily loss limit in the query feeds the afterDailyLimit detector', async () => {
    const { app } = setup();
    const { analysis } = (await json(await app.request('/?accountId=acc1&from=2026-03-01&to=2026-03-31&dailyLossLimit=25'))).data;
    expect(analysis.detectors.find((d: any) => d.id === 'afterDailyLimit').tradeIds).toEqual(['t2', 't5', 't9', 't10']);
    expect((await app.request('/?accountId=acc1&from=2026-03-01&to=2026-03-31&dailyLossLimit=-5')).status).toBe(400);
  });

  it('ALL across currencies → 422 MIXED_CURRENCY with the currencies', async () => {
    const { app } = setup([...behaviourTrades(), row({ id: 'u1', accountId: 'usd', openDate: '2026-03-10T10:00:00Z' })]);
    const res = await app.request('/?accountId=ALL&from=2026-03-01&to=2026-03-31');
    expect(res.status).toBe(422);
    expect(await json(res)).toMatchObject({ success: false, errorCode: 'MIXED_CURRENCY', error: { code: 'MIXED_CURRENCY', currencies: ['INR', 'USD'] } });
  });

  it('ALL in one currency adds the starting balances of the accounts traded', async () => {
    const { app } = setup([...behaviourTrades(), row({ id: 'x2', accountId: 'acc2', openDate: '2026-03-10T10:00:00Z', exitPrice: 104 })]);
    const res = await app.request('/?from=2026-03-01&to=2026-03-31');
    expect(res.status).toBe(200);
    const { analysis } = (await json(res)).data;
    expect(analysis).toMatchObject({ currency: 'INR', tradeCount: 13 });
    // median risk (40 + 50) ÷ 2 over 100,000 + 50,000
    expect(analysis.risk.riskPerTrade.medianShareOfBalance).toBe(0.0003);
  });

  it('no time zone preference → UTC, like GET /stats', async () => {
    const { app, ranges } = setup(behaviourTrades(), { zone: null });
    const { analysis } = (await json(await app.request('/?accountId=acc1&from=2026-03-01&to=2026-03-31'))).data;
    expect(analysis.period.timeZone).toBe('UTC');
    expect(ranges[0].timeZone).toBe('UTC');
    expect(resolveTimeZone('Not/AZone')).toBe('UTC');
  });

  it('passes truncated through', async () => {
    const { app } = setup(behaviourTrades(), { truncated: true });
    expect((await json(await app.request('/?accountId=acc1&from=2026-03-01&to=2026-03-31'))).data.analysis.truncated).toBe(true);
  });

  it('validates the request', async () => {
    const { app } = setup();
    expect((await app.request('/?accountId=acc1&from=2026-03-31&to=2026-03-01')).status).toBe(400);
    expect((await app.request('/?accountId=acc1&from=2026-02-30&to=2026-03-01')).status).toBe(400);
    expect((await app.request('/?accountId=acc1')).status).toBe(400);
    expect((await app.request(`/?accountId=${'x'.repeat(101)}&from=2026-03-01&to=2026-03-31`)).status).toBe(400);
    const missing = await app.request('/?accountId=nope&from=2026-03-01&to=2026-03-31');
    expect(missing.status).toBe(404);
    expect((await json(missing)).errorCode).toBe('NOT_FOUND');
  });
});

describe('POST /analysis/what-if', () => {
  it('replays the period without the trades the rule blocks', async () => {
    const { app } = setup();
    const res = await post(app, '/what-if', { accountId: 'acc1', from: '2026-03-01', to: '2026-03-31', rule: { kind: 'maxTradesPerDay', n: 2 } });
    expect(res.status).toBe(200);
    expect((await json(res)).data).toEqual({ result: { actualNet: 89, replayNet: 49, removed: 4, removedTradeIds: ['t3', 't8', 't9', 't10'], actualAvgR: -0.0636, replayAvgR: -0.3714 }, truncated: false });
  });
  it('400 on a bad rule or body', async () => {
    const { app } = setup();
    expect((await post(app, '/what-if', { accountId: 'acc1', from: '2026-03-01', to: '2026-03-31', rule: { kind: 'maxTradesPerDay', n: 0 } })).status).toBe(400);
    expect((await app.request('/what-if', { method: 'POST', body: 'not json' })).status).toBe(400);
  });
});

describe('POST /analysis/query', () => {
  it('answers a stats query', async () => {
    const { app } = setup();
    const res = await post(app, '/query', { accountId: 'acc1', from: '2026-03-01', to: '2026-03-31', query: { kind: 'stats', groupBy: ['direction'] } });
    expect(res.status).toBe(200);
    expect((await json(res)).data.result.rows.map((r: any[]) => r[0])).toEqual(['Long', 'Short']);
  });
  it('a comparison loads the span of both periods', async () => {
    const { app, ranges } = setup();
    const res = await post(app, '/query', { accountId: 'acc1', query: { kind: 'compare', a: { from: '2026-03-04', to: '2026-03-06' }, b: { from: '2026-03-02', to: '2026-03-03' } } });
    expect(res.status).toBe(200);
    expect(ranges[0]).toMatchObject({ from: '2026-03-02', to: '2026-03-06' });
    expect((await json(res)).data.result.rows[0]).toEqual(['Trades', 7, 5]);
  });
  it('400 on a bad query', async () => {
    const { app } = setup();
    expect((await post(app, '/query', { accountId: 'acc1', from: '2026-03-01', to: '2026-03-31', query: { kind: 'stats', groupBy: ['a', 'b', 'c'] } })).status).toBe(400);
  });
});
