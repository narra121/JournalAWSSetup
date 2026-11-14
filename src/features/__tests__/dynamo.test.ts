import { BatchGetCommand, BatchWriteCommand, PutCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { mockClient } from 'aws-sdk-client-mock';
import { beforeEach, describe, expect, it } from 'vitest';
import { ddb } from '../../shared/dynamo';
import { decodeCursor, dynamoAiStore, encodeCursor } from '../store';
import { dynamoTradeSource, MAX_LOADED_TRADES, MAX_SCANNED_KEYS, toTradeRow } from '../trades-repo';
import { timeId } from '../ids';

const m = mockClient(ddb);
beforeEach(() => {
  m.reset();
  process.env.AI_DATA_TABLE = 'AiData-test';
  process.env.TRADES_TABLE = 'Trades-test';
  process.env.RULES_TABLE = 'Rules-test';
});

describe('AiData store', () => {
  it('queries by userId + sk prefix, newest first, with the page key', async () => {
    m.on(QueryCommand).resolves({ Items: [], LastEvaluatedKey: undefined });
    await dynamoAiStore.query('u1', { prefix: 'INSIGHT#', limit: 20, newestFirst: true, startKey: { userId: 'u1', sk: 'INSIGHT#x' } });
    const input = m.commandCalls(QueryCommand)[0].args[0].input;
    expect(input).toMatchObject({ TableName: 'AiData-test', KeyConditionExpression: 'userId = :u AND begins_with(sk, :p)', ExpressionAttributeValues: { ':u': 'u1', ':p': 'INSIGHT#' }, ScanIndexForward: false, Limit: 20 });
  });

  it('batch deletes in chunks of 25 and retries unprocessed items', async () => {
    m.on(BatchWriteCommand)
      .resolvesOnce({ UnprocessedItems: { 'AiData-test': [{ DeleteRequest: { Key: { userId: 'u1', sk: 'MSG#0' } } }] } })
      .resolves({});
    await dynamoAiStore.delete('u1', Array.from({ length: 30 }, (_, i) => `MSG#${i}`));
    const calls = m.commandCalls(BatchWriteCommand);
    expect(calls).toHaveLength(3);
    expect(calls[0].args[0].input.RequestItems!['AiData-test']).toHaveLength(25);
  });

  it('a delete that never drains fails loudly', async () => {
    m.on(BatchWriteCommand).resolves({ UnprocessedItems: { 'AiData-test': [{ DeleteRequest: { Key: { userId: 'u1', sk: 'a' } } }] } });
    await expect(dynamoAiStore.delete('u1', ['a'])).rejects.toThrow(/unprocessed/);
  });

  it('put writes the item under the caller’s partition', async () => {
    m.on(PutCommand).resolves({});
    await dynamoAiStore.put({ userId: 'u1', sk: 'CHAT#1' });
    expect(m.commandCalls(PutCommand)[0].args[0].input).toMatchObject({ TableName: 'AiData-test', Item: { userId: 'u1', sk: 'CHAT#1' } });
  });

  it('cursors are bound to the user', () => {
    const c = encodeCursor('u1', { userId: 'u1', sk: 'INSIGHT#a' })!;
    expect(decodeCursor('u1', c)).toEqual({ userId: 'u1', sk: 'INSIGHT#a' });
    expect(decodeCursor('u2', c)).toBe('invalid');
    expect(decodeCursor('u1', 'garbage')).toBe('invalid');
    expect(decodeCursor('u1', undefined)).toBeUndefined();
    const forged = Buffer.from(JSON.stringify({ u: 'u2', k: { userId: 'u1', sk: 'x' } })).toString('base64url');
    expect(decodeCursor('u2', forged)).toBe('invalid');
    expect(encodeCursor('u1', undefined)).toBeNull();
  });
});

describe('Trades repository', () => {
  it('loads keys from trades-by-date-gsi across pages, batch-gets them, filters by account', async () => {
    m.on(QueryCommand)
      .resolvesOnce({ Items: [{ userId: 'u1', tradeId: 'a' }, { userId: 'u1', tradeId: 'b' }], LastEvaluatedKey: { userId: 'u1', tradeId: 'b' } })
      .resolvesOnce({ Items: [{ userId: 'u1', tradeId: 'c' }] });
    m.on(BatchGetCommand).resolves({
      Responses: {
        'Trades-test': [
          { tradeId: 'b', accountId: 'acc2', symbol: 'SBIN', side: 'SELL', pnl: -5, openDate: '2026-10-02T04:00:00.000Z' },
          { tradeId: 'a', accountId: 'acc1', symbol: 'INFY', side: 'BUY', pnl: 10, openDate: '2026-10-01T04:00:00.000Z' },
          { tradeId: 'c', accountId: 'acc1', symbol: 'TCS', side: 'BUY', pnl: 3, openDate: '2026-10-03T04:00:00.000Z' },
        ],
      },
    });
    const { trades: rows } = await dynamoTradeSource.loadTrades('u1', { from: '2026-10-01', to: '2026-10-31', accountId: 'acc1' });
    expect(rows.map((r) => r.id)).toEqual(['a', 'c']);
    const q = m.commandCalls(QueryCommand);
    expect(q).toHaveLength(2);
    expect(q[0].args[0].input).toMatchObject({ IndexName: 'trades-by-date-gsi', ExpressionAttributeValues: { ':u': 'u1', ':a': '2026-09-30T18:30:00.000Z', ':b': '2026-10-31T18:29:59.999Z' } });
    expect(m.commandCalls(BatchGetCommand).flatMap((c) => c.args[0].input.RequestItems!['Trades-test'].Keys as unknown[])).toHaveLength(3);
  });

  it('never returns soft-deleted trades (deletedAt set, e.g. an undone import)', async () => {
    m.on(QueryCommand).resolves({ Items: [{ userId: 'u1', tradeId: 'a' }, { userId: 'u1', tradeId: 'gone' }] });
    m.on(BatchGetCommand).resolves({
      Responses: { 'Trades-test': [{ tradeId: 'a', openDate: '2026-10-01T00:00:00Z' }, { tradeId: 'gone', openDate: '2026-10-02T00:00:00Z', deletedAt: '2026-10-03T00:00:00.000Z' }] },
    });
    const { trades, truncated } = await dynamoTradeSource.loadTrades('u1', { from: '2026-10-01', to: '2026-10-31' });
    expect(trades.map((t) => t.id)).toEqual(['a']);
    expect(truncated).toBe(false);
  });

  describe('truncation', () => {
    const keys = (n: number, from = 0) => Array.from({ length: n }, (_, i) => ({ userId: 'u1', tradeId: `t${from + i}` }));
    const echoBatchGet = () =>
      m.on(BatchGetCommand).callsFake((input) => ({ Responses: { 'Trades-test': input.RequestItems['Trades-test'].Keys.map((k: any) => ({ tradeId: k.tradeId, openDate: '2026-10-01T00:00:00Z' })) } }));

    it('more than MAX_LOADED_TRADES keys → the oldest 5,000 are loaded and truncated is true', async () => {
      m.on(QueryCommand).resolvesOnce({ Items: keys(2500), LastEvaluatedKey: { userId: 'u1', tradeId: 't2499' } }).resolvesOnce({ Items: keys(2501, 2500) });
      echoBatchGet();
      const r = await dynamoTradeSource.loadTrades('u1', { from: '2026-10-01', to: '2026-10-31' });
      expect(r.trades).toHaveLength(MAX_LOADED_TRADES);
      expect(r.truncated).toBe(true);
    });

    it('exactly MAX_LOADED_TRADES with more pages pending is truncated', async () => {
      m.on(QueryCommand).resolves({ Items: keys(MAX_LOADED_TRADES), LastEvaluatedKey: { userId: 'u1', tradeId: 'x' } });
      echoBatchGet();
      expect((await dynamoTradeSource.loadTrades('u1', { from: '2026-10-01', to: '2026-10-31' })).truncated).toBe(true);
    });

    it('exactly MAX_LOADED_TRADES and nothing after it is complete', async () => {
      m.on(QueryCommand).resolves({ Items: keys(MAX_LOADED_TRADES) });
      echoBatchGet();
      const r = await dynamoTradeSource.loadTrades('u1', { from: '2026-10-01', to: '2026-10-31' });
      expect(r.trades).toHaveLength(MAX_LOADED_TRADES);
      expect(r.truncated).toBe(false);
    });
  });

  describe('the cap counts live trades of the requested account only (BE-011)', () => {
    const idx = (ids: string[]) => ids.map((tradeId) => ({ userId: 'u1', tradeId }));
    const echo = (make: (tradeId: string) => Record<string, any>) =>
      m.on(BatchGetCommand).callsFake((input) => ({ Responses: { 'Trades-test': input.RequestItems['Trades-test'].Keys.map((k: any) => make(k.tradeId)) } }));

    it('other accounts do not use up the cap: 6,000 rows of which 1,000 are the requested account is complete', async () => {
      const ids = Array.from({ length: 6000 }, (_, i) => `t${i}`);
      m.on(QueryCommand).resolves({ Items: idx(ids) });
      echo((id) => ({ tradeId: id, accountId: Number(id.slice(1)) < 1000 ? 'mine' : 'other', openDate: '2026-10-01T00:00:00Z' }));
      const r = await dynamoTradeSource.loadTrades('u1', { from: '2026-10-01', to: '2026-10-31', accountId: 'mine' });
      expect(r.trades).toHaveLength(1000);
      expect(r.truncated).toBe(false);
    });

    it('soft-deleted trades do not use up the cap either', async () => {
      const ids = Array.from({ length: MAX_LOADED_TRADES + 200 }, (_, i) => `t${i}`);
      m.on(QueryCommand).resolves({ Items: idx(ids) });
      echo((id) => ({ tradeId: id, accountId: 'a', openDate: '2026-10-01T00:00:00Z', ...(Number(id.slice(1)) < 200 ? { deletedAt: 'x' } : {}) }));
      const r = await dynamoTradeSource.loadTrades('u1', { from: '2026-10-01', to: '2026-10-31' });
      expect(r.trades).toHaveLength(MAX_LOADED_TRADES);
      expect(r.truncated).toBe(false);
    });

    it('is truncated once more than MAX_LOADED_TRADES matching trades exist', async () => {
      m.on(QueryCommand).resolves({ Items: idx(Array.from({ length: MAX_LOADED_TRADES + 1 }, (_, i) => `t${i}`)) });
      echo((id) => ({ tradeId: id, accountId: 'mine', openDate: '2026-10-01T00:00:00Z' }));
      const r = await dynamoTradeSource.loadTrades('u1', { from: '2026-10-01', to: '2026-10-31', accountId: 'mine' });
      expect(r.trades).toHaveLength(MAX_LOADED_TRADES);
      expect(r.truncated).toBe(true);
    });

    it('stops reading index rows at MAX_SCANNED_KEYS and says the result is partial', async () => {
      m.on(QueryCommand).resolves({ Items: idx(Array.from({ length: 10_000 }, (_, i) => `t${i}`)), LastEvaluatedKey: { userId: 'u1', tradeId: 'more' } });
      echo((id) => ({ tradeId: id, accountId: 'other', openDate: '2026-10-01T00:00:00Z' }));
      const r = await dynamoTradeSource.loadTrades('u1', { from: '2026-10-01', to: '2026-10-31', accountId: 'mine' });
      expect(m.commandCalls(QueryCommand)).toHaveLength(MAX_SCANNED_KEYS / 10_000);
      expect(r.trades).toHaveLength(0);
      expect(r.truncated).toBe(true);
    });
  });

  it('date bounds are whole IST days; instants are used as given (BE-111)', async () => {
    m.on(QueryCommand).resolves({ Items: [] });
    await dynamoTradeSource.loadTrades('u1', { from: '2026-04-01', to: '2026-04-30' });
    await dynamoTradeSource.loadTrades('u1', { from: '2026-04-01T00:00:00.000Z', to: '2026-04-30T12:00:00.000Z' });
    const [days, instants] = m.commandCalls(QueryCommand).map((c) => c.args[0].input.ExpressionAttributeValues);
    // 2026-04-01 02:00 IST (forex) = 2026-03-31T20:30Z belongs to April
    expect(days).toMatchObject({ ':a': '2026-03-31T18:30:00.000Z', ':b': '2026-04-30T18:29:59.999Z' });
    expect('2026-03-31T20:30:00.000Z' >= (days as any)[':a']).toBe(true);
    expect(instants).toMatchObject({ ':a': '2026-04-01T00:00:00.000Z', ':b': '2026-04-30T12:00:00.000Z' });
  });

  describe('time zone of the date bounds (CONTRACT I1)', () => {
    const rowsAt = (openDates: string[]) => {
      m.on(QueryCommand).resolves({ Items: openDates.map((_, i) => ({ userId: 'u1', tradeId: `t${i}` })) });
      m.on(BatchGetCommand).resolves({ Responses: { 'Trades-test': openDates.map((openDate, i) => ({ tradeId: `t${i}`, openDate })) } });
    };

    it('west of UTC: the query starts at the bare date so date-only trades are found; rows are kept by their local day', async () => {
      rowsAt(['2026-10-01', '2026-10-01T02:00:00.000Z', '2026-10-01T12:00:00.000Z', '2026-11-01T03:00:00.000Z', '2026-11-01']);
      const { trades } = await dynamoTradeSource.loadTrades('u1', { from: '2026-10-01', to: '2026-10-31', timeZone: 'America/New_York' });
      expect(m.commandCalls(QueryCommand)[0].args[0].input.ExpressionAttributeValues).toMatchObject({ ':a': '2026-10-01', ':b': '2026-11-01T03:59:59.999Z' });
      // 02:00Z is 30 Sep 22:00 in New York; 1 Nov 03:00Z is 31 Oct 23:00; the date-only 1 Nov is outside
      expect(trades.map((t) => t.openDate)).toEqual(['2026-10-01', '2026-10-01T12:00:00.000Z', '2026-11-01T03:00:00.000Z']);
    });

    it('8 March 2026 is 23 hours long in New York (clocks go forward); London is still on GMT', async () => {
      rowsAt([]);
      await dynamoTradeSource.loadTrades('u1', { from: '2026-03-08', to: '2026-03-08', timeZone: 'America/New_York' });
      await dynamoTradeSource.loadTrades('u1', { from: '2026-03-08', to: '2026-03-08', timeZone: 'Europe/London' });
      const [ny, london] = m.commandCalls(QueryCommand).map((c) => c.args[0].input.ExpressionAttributeValues);
      expect(ny).toMatchObject({ ':a': '2026-03-08', ':b': '2026-03-09T03:59:59.999Z' });
      expect(london).toMatchObject({ ':a': '2026-03-08', ':b': '2026-03-08T23:59:59.999Z' });
    });

    it('east of UTC: an instant late on the last UTC day belongs to the next local day', async () => {
      rowsAt(['2026-03-31T18:00:00.000Z', '2026-03-31T18:30:00.000Z']);
      const { trades } = await dynamoTradeSource.loadTrades('u1', { from: '2026-03-01', to: '2026-03-31', timeZone: 'Asia/Tokyo' });
      expect(m.commandCalls(QueryCommand)[0].args[0].input.ExpressionAttributeValues).toMatchObject({ ':a': '2026-02-28T15:00:00.000Z', ':b': '2026-03-31T14:59:59.999Z' });
      expect(trades).toEqual([]);
    });

    it('UTC and the IST default', async () => {
      rowsAt([]);
      await dynamoTradeSource.loadTrades('u1', { from: '2026-10-01', to: '2026-10-31', timeZone: 'UTC' });
      await dynamoTradeSource.loadTrades('u1', { from: '2026-10-01', to: '2026-10-31', timeZone: null });
      const [utc, ist] = m.commandCalls(QueryCommand).map((c) => c.args[0].input.ExpressionAttributeValues);
      expect(utc).toMatchObject({ ':a': '2026-10-01', ':b': '2026-10-31T23:59:59.999Z' });
      expect(ist).toMatchObject({ ':a': '2026-09-30T18:30:00.000Z', ':b': '2026-10-31T18:29:59.999Z' });
    });
  });

  it('keys that stay unprocessed after the backoff attempts are an error, not a silent gap (BE-054)', async () => {
    m.on(QueryCommand).resolves({ Items: [{ userId: 'u1', tradeId: 'a' }] });
    m.on(BatchGetCommand).resolves({ Responses: { 'Trades-test': [] }, UnprocessedKeys: { 'Trades-test': { Keys: [{ userId: 'u1', tradeId: 'a' }] } } });
    await expect(dynamoTradeSource.loadTrades('u1', { from: '2026-10-01', to: '2026-10-31' })).rejects.toThrow(/Could not load all trade records/);
    expect(m.commandCalls(BatchGetCommand)).toHaveLength(4);
  });

  it('re-requests unprocessed keys', async () => {
    m.on(QueryCommand).resolves({ Items: [{ userId: 'u1', tradeId: 'a' }, { userId: 'u1', tradeId: 'b' }] });
    m.on(BatchGetCommand)
      .resolvesOnce({ Responses: { 'Trades-test': [{ tradeId: 'a', openDate: '2026-10-01T00:00:00Z' }] }, UnprocessedKeys: { 'Trades-test': { Keys: [{ userId: 'u1', tradeId: 'b' }] } } })
      .resolves({ Responses: { 'Trades-test': [{ tradeId: 'b', openDate: '2026-10-02T00:00:00Z' }] } });
    const { trades: rows } = await dynamoTradeSource.loadTrades('u1', { from: '2026-10-01', to: '2026-10-31' });
    expect(rows.map((r) => r.id)).toEqual(['a', 'b']);
  });

  it('strips the stored -accountId suffix from idempotency keys', async () => {
    m.on(QueryCommand).resolves({ Items: [{ idempotencyKey: 'imp|acc1|zerodha:1:2-acc1' }, { idempotencyKey: 'imp|acc1|zerodha:3:4' }] });
    const keys = await dynamoTradeSource.importedKeys('u1', 'acc1', 'imp|acc1|');
    expect([...keys].sort()).toEqual(['imp|acc1|zerodha:1:2', 'imp|acc1|zerodha:3:4']);
    expect(m.commandCalls(QueryCommand)[0].args[0].input).toMatchObject({ IndexName: 'user-idempotency-gsi', KeyConditionExpression: 'userId = :u AND begins_with(idempotencyKey, :p)' });
  });

  it('reads rule texts and normalises trade rows', async () => {
    m.on(QueryCommand).resolves({ Items: [{ ruleId: 'r1', rule: 'No FOMO' }, { ruleId: 'r2' }] });
    expect([...(await dynamoTradeSource.loadRuleTexts('u1'))]).toEqual([['r1', 'No FOMO']]);
    expect(toTradeRow({ tradeId: 't', accountId: '-1', pnl: '5', stopLoss: 0, mistakes: ['a'] })).toMatchObject({ id: 't', accountId: null, pnl: 0, stopLoss: 0, mistakes: ['a'] });
  });

  it('carries the I1 fields: notes from tradeNotes, option type normalised, reviewed false when absent', () => {
    const r = toTradeRow({
      tradeId: 't', takeProfit: 110, riskRewardRatio: 2, marketCondition: 'Trending', newsEvents: ['CPI'], outcome: 'TP', tradeNotes: 'Clean retest',
      lessons: ['Wait for the close'], optionType: 'CE', expiry: '2026-11-25', reviewed: true,
    });
    expect(r).toMatchObject({ takeProfit: 110, riskRewardRatio: 2, marketCondition: 'Trending', newsEvents: ['CPI'], outcome: 'TP', notes: 'Clean retest', lessons: ['Wait for the close'], optionType: 'call', expiry: '2026-11-25', reviewed: true });
    expect(toTradeRow({ tradeId: 'u', optionType: 'put' })).toMatchObject({ takeProfit: null, riskRewardRatio: null, marketCondition: null, newsEvents: [], outcome: null, notes: null, lessons: [], optionType: 'put', expiry: null, reviewed: false });
    expect(toTradeRow({ tradeId: 'v', optionType: 'PE', reviewed: 'yes' })).toMatchObject({ optionType: 'put', reviewed: false });
    expect(toTradeRow({ tradeId: 'w', optionType: 'straddle' }).optionType).toBeNull();
  });

  it('missing table configuration is an error, not a silent empty result', async () => {
    delete process.env.TRADES_TABLE;
    await expect(dynamoTradeSource.loadTrades('u1', { from: '2026-10-01', to: '2026-10-31' })).rejects.toThrow(/TRADES_TABLE/);
  });
});

describe('timeId', () => {
  it('is sortable, unique and strictly increasing even for the same clock reading', () => {
    const now = new Date('2026-11-11T10:00:00.000Z');
    const ids = Array.from({ length: 50 }, () => timeId(now));
    expect([...ids].sort()).toEqual(ids);
    expect(new Set(ids).size).toBe(50);
    expect(ids[0]).toMatch(/^\d{8}T\d{9}Z_[0-9a-f]{8}$/);
  });
});
