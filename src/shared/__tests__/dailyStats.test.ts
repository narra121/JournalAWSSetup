import { DynamoDBDocumentClient, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { mockClient } from 'aws-sdk-client-mock';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.stubEnv('DAILY_STATS_TABLE', 'stats');
const ddb = mockClient(DynamoDBDocumentClient);
const { queryDailyStats, accountTally, latestTradeDay } = await import('../dailyStats');

beforeEach(() => ddb.reset());

describe('queryDailyStats (BE-091: the one DailyStats query)', () => {
  it('one account reads the main table by sort key', async () => {
    ddb.on(QueryCommand).resolves({ Items: [{ sk: 'a#2026-04-01' }] });
    const r = await queryDailyStats('u1', 'a', '2026-04-01', '2026-04-30');
    expect(r).toEqual([{ sk: 'a#2026-04-01' }]);
    const input = ddb.commandCalls(QueryCommand)[0].args[0].input;
    expect(input.IndexName).toBeUndefined();
    expect(input).toMatchObject({
      TableName: 'stats',
      KeyConditionExpression: 'userId = :userId AND #sk BETWEEN :skStart AND :skEnd',
      ExpressionAttributeNames: { '#sk': 'sk' },
      ExpressionAttributeValues: { ':userId': 'u1', ':skStart': 'a#2026-04-01', ':skEnd': 'a#2026-04-30' },
    });
  });

  it('ALL reads stats-by-date-gsi by date', async () => {
    ddb.on(QueryCommand).resolves({ Items: [] });
    await queryDailyStats('u1', 'ALL', '2026-04-01', '2026-04-30');
    expect(ddb.commandCalls(QueryCommand)[0].args[0].input).toMatchObject({
      IndexName: 'stats-by-date-gsi',
      KeyConditionExpression: 'userId = :userId AND #date BETWEEN :startDate AND :endDate',
      ExpressionAttributeNames: { '#date': 'date' },
      ExpressionAttributeValues: { ':userId': 'u1', ':startDate': '2026-04-01', ':endDate': '2026-04-30' },
    });
  });

  it('follows LastEvaluatedKey through every page', async () => {
    ddb.on(QueryCommand)
      .resolvesOnce({ Items: [{ n: 1 }], LastEvaluatedKey: { k: 1 } })
      .resolvesOnce({ Items: [{ n: 2 }], LastEvaluatedKey: { k: 2 } })
      .resolvesOnce({ Items: [{ n: 3 }] });
    expect(await queryDailyStats('u1', 'ALL', 'a', 'b')).toEqual([{ n: 1 }, { n: 2 }, { n: 3 }]);
    expect(ddb.commandCalls(QueryCommand)[2].args[0].input.ExclusiveStartKey).toEqual({ k: 2 });
  });

  it('a projection may use #date and #sk; both names are then defined', async () => {
    ddb.on(QueryCommand).resolves({ Items: [] });
    await queryDailyStats('u1', 'a', 'x', 'y', 'userId, #sk, #date');
    await queryDailyStats('u1', 'ALL', 'x', 'y', 'userId, #sk, #date');
    for (const call of ddb.commandCalls(QueryCommand)) {
      expect(call.args[0].input.ProjectionExpression).toBe('userId, #sk, #date');
      expect(call.args[0].input.ExpressionAttributeNames).toEqual({ '#date': 'date', '#sk': 'sk' });
    }
  });
});

describe('account counters (M1)', () => {
  it('accountTally sums the day records of one account and names the newest day; rows without trades are skipped', async () => {
    ddb.on(QueryCommand).resolves({ Items: [{ date: '2026-04-01', tradeCount: 2 }, { date: '2026-04-09', tradeCount: 1 }, { date: '2026-05-01', tradeCount: 0 }, { date: '2026-06-01' }] });
    expect(await accountTally('u1', 'a')).toEqual({ tradeCount: 3, lastTradeDate: '2026-04-09' });
    expect(ddb.commandCalls(QueryCommand)[0].args[0].input).toMatchObject({
      ProjectionExpression: '#date, tradeCount',
      ExpressionAttributeValues: { ':skStart': 'a#0000-01-01', ':skEnd': 'a#9999-12-31' },
    });
  });

  it('accountTally of an account without day records is 0 and null', async () => {
    ddb.on(QueryCommand).resolves({ Items: [] });
    expect(await accountTally('u1', 'a')).toEqual({ tradeCount: 0, lastTradeDate: null });
  });

  it('latestTradeDay reads one item of the account, newest sort key first', async () => {
    ddb.on(QueryCommand).resolves({ Items: [{ date: '2026-04-09' }] });
    expect(await latestTradeDay('u1', 'a')).toBe('2026-04-09');
    expect(ddb.commandCalls(QueryCommand)[0].args[0].input).toMatchObject({
      TableName: 'stats',
      ScanIndexForward: false,
      Limit: 1,
      ProjectionExpression: '#date',
      ExpressionAttributeNames: { '#sk': 'sk', '#date': 'date' },
    });
  });

  it('latestTradeDay is null when the account has no day record', async () => {
    ddb.on(QueryCommand).resolves({ Items: [] });
    expect(await latestTradeDay('u1', 'a')).toBeNull();
  });
});
