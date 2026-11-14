import { describe, expect, it } from 'vitest';
import { parseAnalysisQuery, runQuery } from '../query';
import type { AnalysisQuery } from '../types';
import { behaviourTrades } from './build';

const q = (query: AnalysisQuery, timeZone = 'UTC') => runQuery(behaviourTrades(), query, { timeZone });

describe('runQuery', () => {
  it('stats, one way', () => {
    const r = q({ kind: 'stats', groupBy: ['direction'] });
    expect(r.columns).toEqual(['direction', 'trades', 'wins', 'winRate', 'net', 'avgR', 'avgRLow', 'avgRHigh', 'verdict', 'label']);
    expect(r.rows).toEqual([['Long', 11, 6, 0.5455, 119, 0.08, null, null, 'watch', 'too-few'], ['Short', 1, 0, 0, -30, -1.5, null, null, 'watch', 'too-few']]);
    expect(r.label).toBe('too-few');
    expect(r.tradeIds).toHaveLength(12);
  });

  it('stats: the trades behind the table are its rows; trades without the value are named in the note (R-046)', () => {
    const r = q({ kind: 'stats', groupBy: ['optionType'] });
    const inRows = r.rows.reduce((s, row) => s + Number(row[1]), 0);
    expect(r.tradeIds).toHaveLength(inRows);
    expect(r.note).toBe(`${12 - inRows} trades have no option type and are not in the table.`);
  });

  it('stats, two way, with the exploring note', () => {
    const r = q({ kind: 'stats', groupBy: ['optionType', 'expiryDay'] });
    expect(r.rows.map((x) => x.slice(0, 3))).toEqual([['Calls', 'On expiry day', 1], ['Puts', 'Before expiry day', 1]]);
    expect(r.note).toMatch(/Two-way cells are for exploring only/);
  });

  it('stats with filters and no grouping', () => {
    const r = q({ kind: 'stats', groupBy: [], filters: { optionType: 'put' } });
    expect(r.rows).toEqual([['All trades', 1, 1, 1, 40, 0.4, null, null, 'watch', 'too-few']]);
    expect(r.tradeIds).toEqual(['t12']);
    expect(q({ kind: 'stats', groupBy: ['symbol'], filters: { setup: 'nothing' } })).toMatchObject({ rows: [], tradeIds: [], note: 'No trade matches these filters.' });
  });

  it('sequence: after a loss, same day, optionally within minutes', () => {
    expect(q({ kind: 'sequence', after: 'loss', sameDay: true }).tradeIds).toEqual(['t2', 't5', 't7', 't8', 't9']);
    const r = q({ kind: 'sequence', after: 'loss', sameDay: true, withinMinutes: 15 });
    expect(r.tradeIds).toEqual(['t2', 't7']);
    expect(r.rows[0].slice(0, 5)).toEqual(['After a loss the same day within 15 min', 2, 1, 0.5, 280]);
    expect(r.rows[1][1]).toBe(10);
    expect(q({ kind: 'sequence', after: 'win', sameDay: false }).tradeIds).toEqual(['t3', 't4', 't6', 't10', 't11']);
  });

  it('whatIf', () => {
    const r = q({ kind: 'whatIf', rule: { kind: 'maxTradesPerDay', n: 2 } });
    expect(r.rows).toEqual([['Net P&L', 89, 49], ['Average R', -0.0636, -0.3714], ['Trades', 12, 8]]);
    expect(r.tradeIds).toEqual(['t3', 't8', 't9', 't10']);
  });

  it('trades: sorted, limited, nulls last', () => {
    expect(q({ kind: 'trades', sort: 'pnl', limit: 3 }).tradeIds).toEqual(['t2', 't3', 't12']);
    expect(q({ kind: 'trades', sort: 'r', order: 'asc', limit: 2 }).rows).toEqual([['2026-03-02', 'NIFTY', 'Long', null, -200, -2], ['2026-03-03', 'NIFTY', 'Short', null, -30, -1.5]]);
    expect(q({ kind: 'trades', sort: 'r', limit: 20 }).tradeIds.at(-1)).toBe('t5');
    expect(q({ kind: 'trades', sort: 'date', limit: 1 }).tradeIds).toEqual(['t12']);
  });

  it('compare two periods by local day', () => {
    const r = q({ kind: 'compare', a: { from: '2026-03-02', to: '2026-03-03' }, b: { from: '2026-03-04', to: '2026-03-06' } });
    expect(r.columns).toEqual(['measure', '2026-03-02 to 2026-03-03', '2026-03-04 to 2026-03-06']);
    expect(r.rows.slice(0, 3)).toEqual([['Trades', 5, 7], ['Win rate', 0.6, 0.4286], ['Net P&L', 120, -31]]);
    expect(r.rows.at(-1)).toEqual(['Verdict (first against second)', 'watch', null]);
    expect(r.tradeIds).toHaveLength(12);
  });
});

describe('parseAnalysisQuery', () => {
  it('accepts each kind', () => {
    expect(parseAnalysisQuery({ kind: 'stats', groupBy: ['setup', 'session'], filters: { symbol: 'NIFTY' } })).toEqual({ kind: 'stats', groupBy: ['setup', 'session'], filters: { symbol: 'NIFTY' } });
    expect(parseAnalysisQuery({ kind: 'sequence', after: 'win', sameDay: false, withinMinutes: 30 })).toEqual({ kind: 'sequence', after: 'win', sameDay: false, withinMinutes: 30 });
    expect(parseAnalysisQuery({ kind: 'whatIf', rule: { kind: 'stopAfterLosses', n: 2 } })).toEqual({ kind: 'whatIf', rule: { kind: 'stopAfterLosses', n: 2 } });
    expect(parseAnalysisQuery({ kind: 'trades', sort: 'r', limit: 5, order: 'asc' })).toEqual({ kind: 'trades', sort: 'r', limit: 5, order: 'asc' });
    expect(parseAnalysisQuery({ kind: 'compare', a: { from: '2026-01-01', to: '2026-01-31' }, b: { from: '2026-02-01', to: '2026-02-28' } })).toMatchObject({ kind: 'compare' });
  });
  it('rejects bad input with a message', () => {
    const bad = [
      null, [], { kind: 'x' }, { kind: 'stats', groupBy: ['setup', 'session', 'symbol'] }, { kind: 'stats', groupBy: ['setup', 'setup'] }, { kind: 'stats', groupBy: ['colour'] },
      { kind: 'stats', groupBy: [], filters: { colour: 'x' } }, { kind: 'sequence', after: 'draw', sameDay: true }, { kind: 'sequence', after: 'loss' },
      { kind: 'whatIf', rule: { kind: 'nope' } }, { kind: 'trades', sort: 'pnl', limit: 21 }, { kind: 'trades', sort: 'size', limit: 5 },
      { kind: 'compare', a: { from: '2026-02-01', to: '2026-01-01' }, b: { from: '2026-02-01', to: '2026-02-28' } }, { kind: 'compare', a: { from: '2026-02-30', to: '2026-03-01' }, b: { from: '2026-02-01', to: '2026-02-28' } },
    ];
    for (const x of bad) expect(typeof parseAnalysisQuery(x)).toBe('string');
  });
});
