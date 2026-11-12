import { DynamoDBDocumentClient, QueryCommand } from '@aws-sdk/lib-dynamodb';
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
      : { Items: [day('usd1', [t({ pnl: 10 })]), day('inr1', [t({ pnl: 500, exitPrice: 600 })]), day('-1', [t({ pnl: 1 })])] },
  );
});

describe('GET /stats accountId=ALL (B-104)', () => {
  it('keeps the top-level totals and adds one aggregate per currency, unassigned trades and the currency list', async () => {
    const data = await call({ accountId: 'ALL', startDate: '2026-11-01', endDate: '2026-11-30' });
    expect(data.totalTrades).toBe(3);
    expect(data.currencies).toEqual(['INR', 'USD']);
    expect(data.byCurrency.USD.totalPnl).toBe(10);
    expect(data.byCurrency.INR.totalPnl).toBe(500);
    expect(data.unassigned.totalPnl).toBe(1);
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
    expect(adv.advanced.drawdownCurve[0]).toMatchObject({ date: '2026-11-09', peak: 1511 });
    expect(adv.advanced.rDistribution.buckets).toHaveLength(7);
    expect(Object.keys(adv.advanced.strategyExpectancy)).toContain('Unknown');
  });

  it('segments and the weekday x hour grid are part of the normal response', async () => {
    const data = await call({ accountId: 'usd1', startDate: '2026-11-01', endDate: '2026-11-30' });
    expect(data.segments.symbol.X.trades).toBe(3);
    expect(data.weekdayHour.length).toBeGreaterThan(0);
  });
});
