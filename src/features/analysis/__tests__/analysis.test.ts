import { describe, expect, it } from 'vitest';
import { buildAnalysis, drawdownFacts } from '../analysis';
import { tradeFacts } from '../facts';
import { replay } from '../whatif';
import { DETECTOR_IDS, DIMENSIONS } from '../types';
import { at, behaviourTrades, qaAccounts, qaTrades, row } from './build';

const period = { from: '2026-01-01', to: '2026-12-31' };
const analyse = (rows: Parameters<typeof buildAnalysis>[0], extra: Partial<Parameters<typeof buildAnalysis>[1]> = {}) =>
  buildAnalysis(rows, { period, timeZone: 'UTC', currency: 'INR', ...extra });

describe('G5: the QA accounts of report §4 (hand-computed and prototype figures)', () => {
  const usd = qaAccounts.find((a) => a.currency === 'USD')!;
  const inr = qaAccounts.find((a) => a.currency === 'INR')!;
  const A = buildAnalysis(qaTrades('USD'), { period, timeZone: 'Asia/Kolkata', currency: 'USD', startingBalance: usd.initialBalance });
  const B = buildAnalysis(qaTrades('INR'), { period, timeZone: 'Asia/Kolkata', currency: 'INR', startingBalance: inr.initialBalance });

  it('USD: win rate 53.3% (39.1-67.1%), break-even 37.6%, +0.22R, about 180 trades needed', () => {
    expect(A.tradeCount).toBe(45);
    expect(A.label).toBe('provisional');
    expect(A.edge.winRate).toBeCloseTo(24 / 45, 6);
    expect(A.edge.winRateRange!.lo).toBeCloseTo(0.391, 3);
    expect(A.edge.winRateRange!.hi).toBeCloseTo(0.671, 3);
    expect(A.edge.payoff).toBeCloseTo(1.66, 2);
    expect(A.edge.breakEvenWinRate).toBeCloseTo(0.376, 3);
    expect(A.edge.expectancyR).toBeCloseTo(0.22, 2);
    expect(A.edge.expectancyRRange!.lo).toBeLessThan(0);
    expect(A.edge.expectancyRRange!.hi).toBeGreaterThan(0);
    expect(A.edge.tradesNeeded).toBe(180);
  });

  it('USD: 15 of 21 losing trades past the stop, $390.40 beyond plan; planned 2.00R, captured 1.55R, 8 of 24 reached', () => {
    expect(A.risk.beyondStop).toMatchObject({ count: 15, losingTrades: 21, amount: 390.4 });
    expect(A.bridge).toMatchObject({ lossesBeyondStop: -390.4, net: 1108.72, losingTrades: 21, beyondStopTrades: 15, fees: 0 });
    expect(A.bridge.grossProfit + A.bridge.lossesWithinPlan + A.bridge.lossesBeyondStop + A.bridge.lossesWithoutStop + A.bridge.fees).toBeCloseTo(1108.72, 2);
    expect(A.risk.plannedVsCaptured).toMatchObject({ winners: 24, plannedAvgR: 2, reachedTarget: 8 });
    expect(A.risk.plannedVsCaptured!.capturedAvgR).toBeCloseTo(1.55, 2);
    expect(A.risk.plannedVsCaptured!.captureRatio).toBeCloseTo(0.77, 2);
  });

  it('USD: 3 best trades = 43% of profits, $93.72 without them; holding 176 against 124 min; risk median $22.50', () => {
    expect(A.concentration.bestShareOfProfit).toBeCloseTo(0.43, 2);
    expect(A.concentration.netWithoutBest).toBe(93.72);
    expect(A.concentration.worstShareOfLosses).toBeCloseTo(0.55, 2);
    expect(A.timing.holding).toEqual({ winnersMedianMin: 175.5, losersMedianMin: 124 });
    expect(A.risk.riskPerTrade).toMatchObject({ median: 22.5, largest: 240, aboveMultiple: { count: 22, net: 1174.46 } });
    expect(A.timing.byTradeNumber.map((s) => [s.key, s.trades, s.net])).toEqual([['1', 32, 584.38], ['2', 12, 600.11], ['3', 1, -75.77]]);
    expect(A.timing.byTradeNumber[0].avgR).toBeCloseTo(0.33, 2);
  });

  it('INR: 26.1% against a break-even of 50.2%; 11 of 17 losses past the stop cost ₹26,382.89 of a ₹56,787.78 loss', () => {
    expect(B.edge.winRate).toBeCloseTo(6 / 23, 6);
    expect(B.edge.breakEvenWinRate).toBeCloseTo(0.502, 3);
    expect(B.edge.expectancyR).toBeCloseTo(-0.55, 2);
    expect(B.label).toBe('early');
    expect(B.risk.beyondStop).toMatchObject({ count: 11, losingTrades: 17, amount: 26382.89 });
    expect(B.bridge).toMatchObject({ lossesBeyondStop: -26382.89, net: -56787.78 });
    expect(B.risk.plannedVsCaptured).toMatchObject({ winners: 6, plannedAvgR: 2, reachedTarget: 1 });
    expect(B.risk.plannedVsCaptured!.capturedAvgR).toBeCloseTo(1.52, 2);
    expect(B.risk.riskPerTrade).toMatchObject({ median: 4200, largest: 9000, medianShareOfBalance: 0.0084, aboveMultiple: { count: 4, net: 211.46 } });
    expect(B.concentration.bestShareOfProfit).toBeCloseTo(0.88, 2);
    expect(B.concentration.netWithoutBest).toBe(-83540.52);
    expect(B.scenario).toBeNull();
  });

  it('what-if replays on the real sequence (a loss counts once it has closed)', () => {
    const usdFacts = tradeFacts(qaTrades('USD'), 'Asia/Kolkata');
    const inrFacts = tradeFacts(qaTrades('INR'), 'Asia/Kolkata');
    expect(replay(usdFacts, { kind: 'stopAfterLosses', n: 1 })).toMatchObject({ actualNet: 1108.72, replayNet: 1104.81, removed: 5 });
    expect(replay(usdFacts, { kind: 'stopAfterLosses', n: 2 })).toMatchObject({ replayNet: 1108.72, removed: 0 });
    expect(replay(usdFacts, { kind: 'maxTradesPerDay', n: 3 })).toMatchObject({ removed: 0 });
    // 2026-10-01: the second NIFTY trade opened at 11:45Z while the first (−7,295.53) was still open until 12:44Z, so
    // only the third trade (−994.42) comes after a closed loss. The prototype counted by open order: −45,366.12, 3 trades.
    const one = replay(inrFacts, { kind: 'stopAfterLosses', n: 1 });
    expect(one).toMatchObject({ actualNet: -56787.78, replayNet: -55793.36, removed: 1 });
    expect(replay(inrFacts, { kind: 'stopAfterLosses', n: 2 })).toMatchObject({ replayNet: -55793.36, removed: 1 });
  });

  it('nothing on the QA accounts meets the evidence rule', () => {
    for (const a of [A, B]) {
      for (const d of DIMENSIONS) for (const s of a.segments[d]) expect(s.verdict).toBe('watch');
      for (const d of a.detectors) expect(d.verdict).toBe('watch');
    }
  });
});

describe('the bridge adds up (hand-computed behaviour fixture)', () => {
  it('gross profit 415 − within 210 − beyond 110 − fees 6 = net 89', () => {
    expect(analyse(behaviourTrades()).bridge).toEqual({ grossProfit: 415, lossesWithinPlan: -210, lossesBeyondStop: -110, lossesWithoutStop: 0, fees: -6, net: 89, losingTrades: 6, beyondStopTrades: 2 });
  });
  it('losses without a stop are kept apart', () => {
    const b = analyse([row({ id: 'n', openDate: '2026-03-02T09:00:00Z', stopLoss: null, exitPrice: 90 })]).bridge;
    expect(b).toMatchObject({ lossesWithoutStop: -100, lossesWithinPlan: 0, net: -100 });
  });
});

describe('edge cases', () => {
  it('zero trades: every field present, nothing invented', () => {
    const a = analyse([]);
    expect(a).toMatchObject({ tradeCount: 0, label: 'too-few', truncated: false, scenario: null, rolling: [] });
    expect(a.edge).toEqual({ winRate: 0, winRateRange: null, payoff: null, breakEvenWinRate: null, expectancyMoney: null, expectancyR: null, expectancyRRange: null, tradesWithR: 0, tradesNeeded: null });
    expect(Object.keys(a.segments).sort()).toEqual([...DIMENSIONS].sort());
    expect(a.detectors.map((d) => d.id)).toEqual([...DETECTOR_IDS]);
    expect(a.risk).toMatchObject({ avgR: null, rSpread: null, plannedVsCaptured: null, riskPerTrade: null, drawdown: { current: 0, deepest: 0, longestDays: 0, since: null } });
    expect(a.concentration).toMatchObject({ bestShareOfProfit: null, worstShareOfLosses: null, netWithoutBest: 0 });
  });

  it('a single trade', () => {
    const a = analyse([row({ id: 's', openDate: '2026-03-02T09:00:00Z', closeDate: '2026-03-02T10:00:00Z', exitPrice: 110 })]);
    expect(a.edge).toMatchObject({ winRate: 1, payoff: null, breakEvenWinRate: 0, expectancyR: 2, tradesWithR: 1, tradesNeeded: null, winRateRange: null });
    expect(a.segments.symbol).toHaveLength(1);
    expect(a.segments.symbol[0]).toMatchObject({ trades: 1, verdict: 'watch', label: 'too-few', avgRRange: null, tradeIds: ['s'] });
  });

  it('all wins: no losses to split, payoff unknown, break-even 0', () => {
    const rows = Array.from({ length: 25 }, (_, i) => row({ id: `w${i}`, ...at('2026-03-02', `${String(9 + (i % 10)).padStart(2, '0')}:00`, 30), exitPrice: 101 + (i % 3) }));
    const a = analyse(rows);
    expect(a.edge).toMatchObject({ winRate: 1, payoff: null, breakEvenWinRate: 0, tradesNeeded: null });
    expect(a.edge.expectancyRRange!.lo).toBeGreaterThan(0);
    expect(a.bridge).toMatchObject({ lossesWithinPlan: 0, lossesBeyondStop: 0, losingTrades: 0 });
    expect(a.concentration.worstShareOfLosses).toBeNull();
    expect(a.timing.holding.losersMedianMin).toBeNull();
    expect(a.rolling).toHaveLength(1);
  });

  it('break-even trades scale the break-even win rate', () => {
    const rows = [
      row({ id: 'w', openDate: '2026-03-02T09:00:00Z', exitPrice: 110 }),
      row({ id: 'l', openDate: '2026-03-02T10:00:00Z', exitPrice: 95 }),
      row({ id: 'z1', openDate: '2026-03-02T11:00:00Z', exitPrice: 100 }),
      row({ id: 'z2', openDate: '2026-03-02T12:00:00Z', exitPrice: 100 }),
    ];
    // payoff 100 ÷ 50 = 2; half the trades are decisive: break-even at 0.5 ÷ 3 of all trades; the actual 25% is above it
    expect(analyse(rows).edge).toMatchObject({ winRate: 0.25, payoff: 2, breakEvenWinRate: 0.1667 });
  });

  it('truncated is passed through', () => {
    expect(analyse([], { truncated: true }).truncated).toBe(true);
  });

  it('a date-only open date is analysed on its own day, without an hour', () => {
    const a = analyse([row({ id: 'd', openDate: '2026-03-04', closeDate: '2026-03-04', exitPrice: 104 })], { timeZone: 'America/New_York' });
    expect(a.segments.weekday.map((s) => s.key)).toEqual(['wed']);
    expect(a.segments.hour).toEqual([]);
    expect(a.segments.holding).toEqual([]);
  });
});

describe('rolling expectancy, drawdown and scenario', () => {
  it('rolling: average R of the last 20, one point per close day from the 20th trade', () => {
    const rows = Array.from({ length: 24 }, (_, i) => row({ id: `r${i}`, ...at(`2026-03-${String(1 + i).padStart(2, '0')}`, '09:00', 10), exitPrice: i < 4 ? 90 : 105 }));
    const pts = analyse(rows).rolling;
    // R is −2 for the first 4 trades and +1 after; the 20th close (03-20) averages (4 × −2 + 16 × 1) ÷ 20
    expect(pts[0]).toEqual({ date: '2026-03-20', avgR: 0.4 });
    expect(pts.at(-1)).toEqual({ date: '2026-03-24', avgR: 1 });
    expect(pts).toHaveLength(5);
  });

  it('drawdown: deepest, current and the longest time below the previous high (calendar days)', () => {
    const day = (d: string, pnl: number) => row({ id: d, openDate: `${d}T09:00:00Z`, closeDate: `${d}T10:00:00Z`, pnl });
    const fs = tradeFacts([day('2026-03-02', 100), day('2026-03-03', -50), day('2026-03-04', -80), day('2026-03-06', 200)], 'UTC');
    expect(drawdownFacts(fs)).toEqual({ current: 0, deepest: 130, longestDays: 3, since: null });
    const open = tradeFacts([day('2026-03-02', 100), day('2026-03-03', -50)], 'UTC');
    expect(drawdownFacts(open)).toEqual({ current: 50, deepest: 50, longestDays: 1, since: '2026-03-03' });
  });

  it('scenario: none below 50 trades; from 50, seeded and repeatable, with ±10% odds when the balance is known', () => {
    const rows = (n: number) => Array.from({ length: n }, (_, i) => row({ id: `s${i}`, ...at(`2026-0${1 + Math.floor(i / 28)}-${String(1 + (i % 28)).padStart(2, '0')}`, '09:00', 10), exitPrice: i % 3 ? 104 : 96 }));
    expect(analyse(rows(49)).scenario).toBeNull();
    const s = analyse(rows(50), { startingBalance: 10_000 }).scenario!;
    expect(analyse(rows(50), { startingBalance: 10_000 }).scenario).toEqual(s);
    expect(s).toMatchObject({ basedOn: 50, runs: 5000, horizon: 100, drawdownRisk: { amount: 500 }, targetBeforeLimit: { target: 1000, limit: -1000 } });
    expect(s.final.p5).toBeLessThan(s.final.p50);
    expect(s.final.p50).toBeLessThan(s.final.p95);
    // +40 two times in three, −40 once: +13.33 a trade, about +1,333 over 100 trades
    expect(s.final.p50).toBeGreaterThan(900);
    expect(s.final.p50).toBeLessThan(1800);
    expect(s.profitableShare).toBeGreaterThan(0.95);
    expect(analyse(rows(50)).scenario!.targetBeforeLimit).toBeNull();
  });
});

describe('performance at the 5,000-trade cap', () => {
  it('builds the whole analysis in well under the API timeout', () => {
    const rows = Array.from({ length: 5000 }, (_, i) => {
      const d = new Date(Date.UTC(2025, 0, 1) + Math.floor(i / 5) * 86_400_000).toISOString().slice(0, 10);
      return row({ id: `p${i}`, ...at(d, `${String(9 + (i % 5)).padStart(2, '0')}:15`, 20), symbol: ['A', 'B', 'C', 'D'][i % 4], setupType: `S${i % 7}`, tags: [`g${i % 3}`], exitPrice: 100 + ((i * 7) % 11) - 5 });
    });
    const t0 = Date.now();
    const a = analyse(rows);
    expect(a.tradeCount).toBe(5000);
    expect(Date.now() - t0).toBeLessThan(10_000);
  });
});
