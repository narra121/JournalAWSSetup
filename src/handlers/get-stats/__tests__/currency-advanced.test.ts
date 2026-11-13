import { DynamoDBDocumentClient, GetCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { mockClient } from 'aws-sdk-client-mock';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { computeDailyRecord } from '../../../shared/stats-aggregator';

vi.stubEnv('DAILY_STATS_TABLE', 'stats');
vi.stubEnv('ACCOUNTS_TABLE', 'accounts');
const ddb = mockClient(DynamoDBDocumentClient);
const { handler } = await import('../app');

const t = (o: any) => ({ userId: 'u1', tradeId: Math.random().toString(), symbol: 'X', side: 'BUY', quantity: 1, entryPrice: 100, exitPrice: 110, stopLoss: 95, pnl: 10, openDate: '2026-11-09T10:00:00Z', ...o });
const day = (accountId: string, trades: any[]) => computeDailyRecord('u1', accountId, '2026-11-09', trades)!;

const event = (query: Record<string, string>) =>
  ({ requestContext: { requestId: 'r', authorizer: { jwt: { claims: { sub: 'u1' } } } }, queryStringParameters: query }) as any;
const call = async (q: Record<string, string>) => JSON.parse(((await handler(event(q))) as any).body).data;

beforeEach(() => {
  ddb.reset();
  ddb.on(QueryCommand).callsFake((input) =>
    input.TableName === 'accounts'
      ? { Items: [{ accountId: 'usd1', currency: 'USD' }, { accountId: 'inr1', currency: 'INR' }] }
      : { Items: [day('usd1', [t({ pnl: 10 })]), day('inr1', [t({ pnl: 500, exitPrice: 600 })])] },
  );
});

describe('GET /stats accountId=ALL (B-104)', () => {
  it('keeps the top-level totals and adds one aggregate per currency and the currency list (no unassigned block: no -1 day records exist)', async () => {
    const data = await call({ accountId: 'ALL', startDate: '2026-11-01', endDate: '2026-11-30' });
    expect(data.totalTrades).toBe(2);
    expect(data.currencies).toEqual(['INR', 'USD']);
    expect(data.byCurrency.USD.totalPnl).toBe(10);
    expect(data.byCurrency.INR.totalPnl).toBe(500);
    expect(data.unassigned).toBeUndefined();
  });

  it('a single account has no per-currency block', async () => {
    const data = await call({ accountId: 'usd1', startDate: '2026-11-01', endDate: '2026-11-30' });
    expect(data.byCurrency).toBeUndefined();
  });
});

describe('GET /stats sections=advanced (B-107)', () => {
  it('adds the R histogram, drawdown curve and per-strategy expectancy only when asked', async () => {
    const plain = await call({ accountId: 'ALL', startDate: '2026-11-01', endDate: '2026-11-30' });
    expect(plain.advanced).toBeUndefined();
    const adv = await call({ accountId: 'ALL', startDate: '2026-11-01', endDate: '2026-11-30', sections: 'advanced', totalCapital: '1000' });
    expect(adv.advanced.drawdownCurve[0]).toMatchObject({ date: '2026-11-09', peak: 1510 });
    expect(adv.advanced.rDistribution.buckets).toHaveLength(7);
    expect(Object.keys(adv.advanced.strategyExpectancy)).toContain('Unknown');
  });

  it('segments and the weekday x hour grid are part of the normal response', async () => {
    const data = await call({ accountId: 'usd1', startDate: '2026-11-01', endDate: '2026-11-30' });
    expect(data.segments.symbol.X.trades).toBe(2);
    expect(data.weekdayHour.length).toBeGreaterThan(0);
  });
});

describe('GET /stats max drawdown base (BE-036)', () => {
  const losing = (accountId: string) => day(accountId, [t({ pnl: -10 }), t({ pnl: 5, exitPrice: 115 })]);

  it('a single account without totalCapital uses its own initial balance, so the drawdown is a real % of the starting balance', async () => {
    ddb.on(QueryCommand).resolves({ Items: [losing('usd1')] });
    ddb.on(GetCommand).resolves({ Item: { initialBalance: 1000 } });
    const data = await call({ accountId: 'usd1', startDate: '2026-11-01', endDate: '2026-11-30' });
    expect(data.maxDrawdown).toBeCloseTo(1, 5); // 10 of 1000
    expect(ddb.commandCalls(GetCommand)[0].args[0].input).toMatchObject({ Key: { userId: 'u1', accountId: 'usd1' } });
  });

  it('an explicit totalCapital wins and is not looked up', async () => {
    ddb.on(QueryCommand).resolves({ Items: [losing('usd1')] });
    const data = await call({ accountId: 'usd1', startDate: '2026-11-01', endDate: '2026-11-30', totalCapital: '100' });
    expect(data.maxDrawdown).toBeCloseTo(10, 5);
    expect(ddb.commandCalls(GetCommand)).toHaveLength(0);
  });

  it('ALL accounts without totalCapital has no drawdown percentage (null, not an invented base)', async () => {
    ddb.on(QueryCommand).resolves({ Items: [losing('usd1')] });
    const data = await call({ accountId: 'ALL', startDate: '2026-11-01', endDate: '2026-11-30' });
    expect(data.maxDrawdown).toBeNull();
  });

  it('a failing account lookup leaves the drawdown null instead of failing the request', async () => {
    ddb.on(QueryCommand).resolves({ Items: [losing('usd1')] });
    ddb.on(GetCommand).rejects(new Error('throttled'));
    const data = await call({ accountId: 'usd1', startDate: '2026-11-01', endDate: '2026-11-30' });
    expect(data.maxDrawdown).toBeNull();
  });
});

