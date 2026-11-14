import { describe, expect, it } from 'vitest';
import { tradeFacts } from '../../analysis/facts';
import { fakeQuota, memoryStore, tradeSource, withUser } from '../../__tests__/helpers';
import { rTrade, tr } from '../../insights/__tests__/fixtures';
import type { TradeRow } from '../../trades-repo';
import { focusApp } from '../routes';
import { focusCheck, focusRuleText, parseFocusRule } from '../rules';

const put = (app: ReturnType<typeof withUser>, body: unknown) => app.request('/', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

/** 2026-11-02: a 09:00 −1R loss, a 09:10 re-entry +1R, a 10:00 −1.6R loss; 11-03: a no-stop trade. */
function trades(): TradeRow[] {
  return [
    rTrade('a', '2026-11-02', '09:00', -1),
    rTrade('b', '2026-11-02', '09:30', 1),
    rTrade('c', '2026-11-02', '10:00', -1.6),
    tr('d', '2026-11-03', '09:00', { stopLoss: null, exitPrice: 90 }),
  ];
}

describe('focus rules', () => {
  it('parses what-if rules and the three behaviour rules; rejects the rest', () => {
    expect(parseFocusRule({ kind: 'exitAtStop' })).toEqual({ kind: 'exitAtStop' });
    expect(parseFocusRule({ kind: 'pauseAfterLoss', minutes: 15 })).toEqual({ kind: 'pauseAfterLoss', minutes: 15 });
    expect(parseFocusRule({ kind: 'maxTradesPerDay', n: 3 })).toEqual({ kind: 'maxTradesPerDay', n: 3 });
    expect(parseFocusRule({ kind: 'pauseAfterLoss', minutes: 0 })).toMatch(/minutes/);
    expect(parseFocusRule({ kind: 'maxTradesPerDay', n: 0 })).toMatch(/whole number/);
    expect(parseFocusRule({ kind: 'buyMore' })).toMatch(/exitAtStop/);
    expect(parseFocusRule(null)).toMatch(/object/);
  });

  it('every rule reads as one if-then sentence', () => {
    expect(focusRuleText({ kind: 'exitAtStop' })).toBe('If price reaches my stop, I exit.');
    expect(focusRuleText({ kind: 'stopAfterLosses', n: 2 })).toBe('If I have closed 2 losing trades today, I stop trading for the day.');
    expect(focusRuleText({ kind: 'noTradesAfter', time: '14:30' })).toBe("If it is 14:30 or later, I don't open a trade.");
    expect(focusRuleText({ kind: 'skipSegment', dimension: 'weekday', key: 'fri' }, 'Friday')).toBe("If it is Friday, I don't trade.");
    expect(focusRuleText({ kind: 'maxRiskMultiple', multiple: 1.5 })).toBe('If a trade would risk more than 1.5× my usual amount, I cut the size.');
  });

  it('kept/broken from the trades: blockedBy for what-if rules, the trade itself for behaviour rules', () => {
    const f = tradeFacts(trades(), 'UTC');
    const all = () => true;
    expect(focusCheck(f, { kind: 'stopAfterLosses', n: 1 }, all)).toMatchObject({ checked: 4, kept: 2, broken: 2, brokenTradeIds: ['b', 'c'], brokenNet: -30, cost: 30 });
    expect(focusCheck(f, { kind: 'pauseAfterLoss', minutes: 15 }, all)).toMatchObject({ broken: 1, brokenTradeIds: ['b'] });
    expect(focusCheck(f, { kind: 'exitAtStop' }, all)).toMatchObject({ checked: 2, kept: 1, broken: 1, brokenTradeIds: ['c'], cost: 30 });
    expect(focusCheck(f, { kind: 'setStop' }, all)).toMatchObject({ broken: 1, brokenTradeIds: ['d'], cost: 100 });
    expect(focusCheck(f, { kind: 'maxTradesPerDay', n: 2 }, all)).toMatchObject({ broken: 1, brokenTradeIds: ['c'] });
    // only trades in scope are checked, but the day's earlier trades still count toward the rule
    expect(focusCheck(f, { kind: 'maxTradesPerDay', n: 2 }, (x) => x.t.id !== 'a')).toMatchObject({ checked: 3, broken: 1 });
  });
});

describe('GET/PUT/DELETE /v1/insights/focus', () => {
  const setup = () => {
    const store = memoryStore();
    const deps = { store, trades: tradeSource(trades()), timeZone: async () => null, now: () => new Date('2026-11-02T09:15:00Z') };
    return { store, deps, app: withUser(focusApp(deps), 'u1', fakeQuota().quota) };
  };

  it('none at first; PUT sets one rule with its sentence and start; GET shows kept/broken since then; DELETE clears it', async () => {
    const { app, deps } = setup();
    expect(((await (await app.request('/')).json()) as any).data).toEqual({ focus: null, progress: null });
    const res = await put(app, { rule: { kind: 'pauseAfterLoss', minutes: 15 }, findingKey: 'detector:reentryAfterLoss' });
    expect(((await res.json()) as any).data.focus).toEqual({ rule: { kind: 'pauseAfterLoss', minutes: 15 }, text: 'If a trade closes at a loss, I wait 15 minutes before the next entry.', startedAt: '2026-11-02T09:15:00.000Z', findingKey: 'detector:reentryAfterLoss' });

    const later = withUser(focusApp({ ...deps, now: () => new Date('2026-11-04T00:00:00Z') }), 'u1', fakeQuota().quota);
    const got = ((await (await later.request('/')).json()) as any).data;
    // trade a (09:00) opened before the start and is not checked
    expect(got.progress).toEqual({ checked: 3, kept: 2, broken: 1, brokenTradeIds: ['b'], truncated: false });

    expect(((await (await app.request('/', { method: 'DELETE' })).json()) as any).data).toEqual({ deleted: true });
    expect(((await (await app.request('/')).json()) as any).data.focus).toBeNull();
  });

  it('one active focus: a second PUT replaces the first; own text is kept; bad input is a 400', async () => {
    const { app, store } = setup();
    await put(app, { rule: { kind: 'exitAtStop' } });
    await put(app, { rule: { kind: 'maxTradesPerDay', n: 2 }, text: '  Two trades,   then done. ' });
    expect([...store.items.values()].filter((i) => i.entity === 'focus')).toHaveLength(1);
    expect(((await (await app.request('/')).json()) as any).data.focus).toMatchObject({ rule: { kind: 'maxTradesPerDay', n: 2 }, text: 'Two trades, then done.' });
    expect((await put(app, { rule: { kind: 'nope' } })).status).toBe(400);
    expect((await put(app, { rule: { kind: 'exitAtStop' }, text: 'x'.repeat(201) })).status).toBe(400);
    expect((await put(app, { rule: { kind: 'exitAtStop' }, text: '   ' })).status).toBe(400);
    expect((await app.request('/', { method: 'PUT', body: 'not json' })).status).toBe(400);
  });

  it('is per user', async () => {
    const { app, deps } = setup();
    await put(app, { rule: { kind: 'exitAtStop' } });
    const other = withUser(focusApp(deps), 'u2', fakeQuota().quota);
    expect(((await (await other.request('/')).json()) as any).data.focus).toBeNull();
  });
});
