import { describe, expect, it } from 'vitest';
import { tradeFacts } from '../facts';
import { parseWhatIfRule, replay } from '../whatif';
import { behaviourTrades } from './build';

const facts = tradeFacts(behaviourTrades(), 'UTC');

describe('what-if replay (hand-computed on the behaviour fixture, actual net 89)', () => {
  it('stopAfterLosses: a loss counts once it has closed, among the trades still taken', () => {
    expect(replay(facts, { kind: 'stopAfterLosses', n: 1 })).toEqual({
      actualNet: 89, replayNet: -241, removed: 7, removedTradeIds: ['t2', 't3', 't5', 't7', 't8', 't9', 't10'], actualAvgR: -0.0636, replayAvgR: -0.62,
    });
    expect(replay(facts, { kind: 'stopAfterLosses', n: 2 })).toMatchObject({ replayNet: 89, removed: 3, removedTradeIds: ['t8', 't9', 't10'] });
  });
  it('maxTradesPerDay keeps the first n of each day', () => {
    expect(replay(facts, { kind: 'maxTradesPerDay', n: 2 })).toMatchObject({ replayNet: 49, removedTradeIds: ['t3', 't8', 't9', 't10'] });
  });
  it('noTradesAfter blocks trades opened at or after the local time', () => {
    expect(replay(facts, { kind: 'noTradesAfter', time: '10:30' })).toMatchObject({ replayNet: 19, removedTradeIds: ['t3', 't5', 't9', 't10'] });
    const ist = replay(tradeFacts(behaviourTrades(), 'Asia/Kolkata'), { kind: 'noTradesAfter', time: '16:00' });
    expect(ist.removedTradeIds).toEqual(['t3', 't5', 't9', 't10']);
  });
  it('skipSegment matches a key or a name', () => {
    expect(replay(facts, { kind: 'skipSegment', dimension: 'expiryDay', key: 'expiry-day' })).toMatchObject({ replayNet: 139, removedTradeIds: ['t11'] });
    expect(replay(facts, { kind: 'skipSegment', dimension: 'optionType', key: 'Calls' }).removedTradeIds).toEqual(['t11']);
    expect(replay(facts, { kind: 'skipSegment', dimension: 'symbol', key: 'none' }).removed).toBe(0);
  });
  it('maxRiskMultiple drops trades above the multiple of the median risk (40)', () => {
    expect(replay(facts, { kind: 'maxRiskMultiple', multiple: 2 })).toMatchObject({ replayNet: -41, removedTradeIds: ['t1', 't2', 't3', 't11', 't12'] });
  });
  it('no trades: nothing to remove', () => {
    expect(replay([], { kind: 'maxTradesPerDay', n: 1 })).toEqual({ actualNet: 0, replayNet: 0, removed: 0, removedTradeIds: [], actualAvgR: null, replayAvgR: null });
  });
});

describe('parseWhatIfRule', () => {
  it('accepts each kind', () => {
    expect(parseWhatIfRule({ kind: 'stopAfterLosses', n: 2 })).toEqual({ kind: 'stopAfterLosses', n: 2 });
    expect(parseWhatIfRule({ kind: 'maxTradesPerDay', n: 3, extra: 1 })).toEqual({ kind: 'maxTradesPerDay', n: 3 });
    expect(parseWhatIfRule({ kind: 'noTradesAfter', time: '20:00' })).toEqual({ kind: 'noTradesAfter', time: '20:00' });
    expect(parseWhatIfRule({ kind: 'skipSegment', dimension: 'setup', key: 'breakout' })).toEqual({ kind: 'skipSegment', dimension: 'setup', key: 'breakout' });
    expect(parseWhatIfRule({ kind: 'maxRiskMultiple', multiple: 1.5 })).toEqual({ kind: 'maxRiskMultiple', multiple: 1.5 });
  });
  it('rejects bad input with a message', () => {
    for (const bad of [null, 'x', {}, { kind: 'stopAfterLosses', n: 0 }, { kind: 'stopAfterLosses', n: 1.5 }, { kind: 'noTradesAfter', time: '24:00' }, { kind: 'noTradesAfter', time: '9:00' }, { kind: 'skipSegment', dimension: 'colour', key: 'x' }, { kind: 'skipSegment', dimension: 'setup', key: '' }, { kind: 'maxRiskMultiple', multiple: 0.5 }]) {
      expect(typeof parseWhatIfRule(bad)).toBe('string');
    }
  });
});
