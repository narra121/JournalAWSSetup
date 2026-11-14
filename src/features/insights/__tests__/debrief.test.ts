import { describe, expect, it } from 'vitest';
import { fakeQuota, withUser } from '../../__tests__/helpers';
import { putFocus } from '../../focus/store';
import type { TradeRow } from '../../trades-repo';
import { insightsApp } from '../routes';
import { insightDeps, rTrade, tr } from './fixtures';

const day = (n: number) => new Date(Date.parse('2026-09-15T00:00:00Z') + n * 86_400_000).toISOString().slice(0, 10);

/** 40 Breakout trades (risk 50) before 2026-11-02; that day a −1R loss closes 09:05, then a 2× size Scalp at 09:10 loses −1.6R. */
function trades(): TradeRow[] {
  return [
    ...Array.from({ length: 40 }, (_, i) => rTrade(`h${i}`, day(i), '09:00', i % 2 ? 1 : -1, { setupType: 'Breakout' })),
    tr('x1', '2026-11-02', '09:00', { setupType: 'Breakout', stopLoss: 95, exitPrice: 95 }, 5),
    tr('x2', '2026-11-02', '09:10', { setupType: 'Scalp', stopLoss: 95, exitPrice: 92, quantity: 20 }),
    tr('x3', '2026-11-03', '09:00', { setupType: 'Breakout', stopLoss: 95, takeProfit: 110, exitPrice: 110 }),
    tr('x4', '2026-11-04', '09:00', { stopLoss: null, exitPrice: 104 }),
  ];
}

const states = (d: any) => Object.fromEntries(d.checks.map((c: any) => [c.id, c.state]));

describe('GET /v1/insights/debrief/:tradeId (report §5.4)', () => {
  const setup = () => {
    const { deps, store } = insightDeps(trades());
    return { store, app: withUser(insightsApp(deps), 'u1', fakeQuota().quota) };
  };
  const get = async (app: ReturnType<typeof setup>['app'], id: string) => app.request(`/debrief/${id}`);

  it('a trade that broke most of the checks, each with the fact behind it, and "1 of 5 met"', async () => {
    const { app } = setup();
    const d = ((await (await get(app, 'x2')).json()) as any).data.debrief;
    expect(states(d)).toEqual({ stopSet: 'met', riskWithinUsual: 'notMet', lossKeptOrTarget: 'notMet', notAfterLoss: 'notMet', withinTradeCap: 'notApplicable', setupHistory: 'notMet' });
    expect(d).toMatchObject({ tradeId: 'x2', metCount: 1, total: 5, currency: 'INR', timeZone: 'UTC' });
    const detail = Object.fromEntries(d.checks.map((c: any) => [c.id, c.detail]));
    expect(detail.riskWithinUsual).toBe('Risked ₹100.00, 2.0× your median of ₹50.00 over the last 90 days.');
    expect(detail.lossKeptOrTarget).toBe('Lost −1.60R, past the stop.');
    expect(detail.notAfterLoss).toBe('Opened 5 minutes after a losing trade closed.');
    expect(detail.setupHistory).toBe('1 trade of "Scalp" in the last 90 days; 30 are needed to judge it.');
  });

  it('with a daily-cap focus the trade number is checked too', async () => {
    const { app, store } = setup();
    await putFocus(store, 'u1', { rule: { kind: 'maxTradesPerDay', n: 1 }, text: 'One trade a day.', startedAt: '2026-10-01T00:00:00.000Z', findingKey: null });
    const d = ((await (await get(app, 'x2')).json()) as any).data.debrief;
    expect(d.checks.find((c: any) => c.id === 'withinTradeCap')).toMatchObject({ state: 'notMet', detail: 'Trade 2 of the day; your cap is 1.' });
    expect(d).toMatchObject({ metCount: 1, total: 6 });
  });

  it('a winner that reached its target, on a setup with enough history', async () => {
    const { app } = setup();
    const d = ((await (await get(app, 'x3')).json()) as any).data.debrief;
    expect(states(d)).toMatchObject({ stopSet: 'met', riskWithinUsual: 'met', lossKeptOrTarget: 'met', notAfterLoss: 'met', setupHistory: 'met' });
    expect(d.checks.find((c: any) => c.id === 'lossKeptOrTarget').detail).toBe('Reached the target: +2.00R of 2.00R planned.');
    expect(d).toMatchObject({ metCount: 5, total: 5 });
  });

  it('a trade without a stop: the checks that need one do not apply', async () => {
    const { app } = setup();
    const d = ((await (await get(app, 'x4')).json()) as any).data.debrief;
    expect(states(d)).toEqual({ stopSet: 'notMet', riskWithinUsual: 'notApplicable', lossKeptOrTarget: 'notApplicable', notAfterLoss: 'met', withinTradeCap: 'notApplicable', setupHistory: 'notApplicable' });
    expect(d).toMatchObject({ metCount: 1, total: 2 });
  });

  it('404 for a trade that does not exist, was deleted, or another user owns', async () => {
    const { app } = setup();
    expect((await get(app, 'nope')).status).toBe(404);
    expect((await get(app, 'bad id!')).status).toBe(404);
    const { deps } = insightDeps(trades(), { tradeById: async () => null });
    expect((await withUser(insightsApp(deps), 'u2', fakeQuota().quota).request('/debrief/x2')).status).toBe(404);
  });
});
