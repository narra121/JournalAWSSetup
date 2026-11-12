import { BatchGetCommand, BatchWriteCommand, PutCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { mockClient } from 'aws-sdk-client-mock';
import { beforeEach, describe, expect, it } from 'vitest';
import { ddb } from '../../shared/dynamo';
import { decodeCursor, dynamoAiStore, encodeCursor } from '../store';
import { dynamoTradeSource, MAX_LOADED_TRADES, toTradeRow } from '../trades-repo';
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
    expect(q[0].args[0].input).toMatchObject({ IndexName: 'trades-by-date-gsi', ExpressionAttributeValues: { ':u': 'u1', ':a': '2026-10-01', ':b': '2026-10-31T23:59:59.999Z' } });
    expect(m.commandCalls(BatchGetCommand)[0].args[0].input.RequestItems!['Trades-test'].Keys).toHaveLength(3);
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
    m.on(QueryCommand).resolves({ Items: [{ ruleId: 'r1', text: 'No FOMO' }, { ruleId: 'r2' }] });
    expect([...(await dynamoTradeSource.loadRuleTexts('u1'))]).toEqual([['r1', 'No FOMO']]);
    expect(toTradeRow({ tradeId: 't', accountId: '-1', pnl: '5', stopLoss: 0, mistakes: ['a'] })).toMatchObject({ id: 't', accountId: null, pnl: 0, stopLoss: 0, mistakes: ['a'] });
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
