import { DynamoDBDocumentClient, GetCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { mockClient } from 'aws-sdk-client-mock';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.stubEnv('USER_POOL_ID', 'us-east-1_t');
vi.stubEnv('USER_POOL_CLIENT_ID', 'c');
vi.stubEnv('ALLOWED_ORIGINS', 'https://dev.tradequt.com');
vi.stubEnv('DAILY_STATS_TABLE', 'stats');
vi.stubEnv('GOALS_TABLE', 'goals');
vi.stubEnv('RULES_TABLE', 'rules');
vi.stubEnv('USER_PREFERENCES_TABLE', 'prefs');

const ddb = mockClient(DynamoDBDocumentClient);

const { createApp } = await import('../app');
const { periodWindows } = await import('../goals/history');
const { setTokenVerifier } = await import('../auth/cognito');

describe('periodWindows', () => {
  it('weeks run Monday to Sunday, oldest first, ending with the current week', () => {
    const w = periodWindows('week', 3, new Date('2026-11-11T10:00:00Z')); // Wednesday
    expect(w).toEqual([
      { periodKey: 'week#2026-10-26', startDate: '2026-10-26', endDate: '2026-11-01' },
      { periodKey: 'week#2026-11-02', startDate: '2026-11-02', endDate: '2026-11-08' },
      { periodKey: 'week#2026-11-09', startDate: '2026-11-09', endDate: '2026-11-15' },
    ]);
  });

  it('weeks can start on Sunday', () => {
    expect(periodWindows('week', 1, new Date('2026-11-11T10:00:00Z'), 'sun')[0]).toMatchObject({ startDate: '2026-11-08', endDate: '2026-11-14' });
  });

  it('months cover the whole month and cross a year boundary', () => {
    const w = periodWindows('month', 3, new Date('2026-01-15T00:00:00Z'));
    expect(w.map((x) => x.periodKey)).toEqual(['month#2025-11', 'month#2025-12', 'month#2026-01']);
    expect(w[1]).toMatchObject({ startDate: '2025-12-01', endDate: '2025-12-31' });
  });
});

describe('GET /v1/goals/history', () => {
  const app = createApp();
  const get = (qs = '') => app.request(`/v1/goals/history${qs}`, { headers: { authorization: 'Bearer good' } });
  const day = (date: string, totalPnl: number, extra: Record<string, unknown> = {}) => ({
    userId: 'u1', sk: `acc1#${date}`, accountId: 'acc1', date, tradeCount: 2, wins: 1, losses: 1, totalPnl, grossProfit: Math.max(totalPnl, 0), grossLoss: 0, pnlSequence: [totalPnl], ...extra,
  });
  const goal = (key: string, goalType: string, target: number) => ({ userId: 'u1', goalId: `${key}#g-${goalType}`, goalType, period: key.startsWith('month') ? 'monthly' : 'weekly', target, accountId: null });
  const calls = (table: string) => ddb.commandCalls(QueryCommand).filter((c) => c.args[0].input.TableName === table);

  beforeEach(() => {
    ddb.reset();
    setTokenVerifier({ verify: async () => ({ sub: 'u1' }) });
    ddb.on(GetCommand).resolves({});
    ddb.on(QueryCommand, { TableName: 'stats' }).resolves({ Items: [] });
    ddb.on(QueryCommand, { TableName: 'goals' }).resolves({ Items: [] });
    ddb.on(QueryCommand, { TableName: 'rules' }).resolves({ Items: [] });
  });
  afterEach(() => vi.useRealTimers());

  it('returns each period with the goal results and rule compliance, from ONE read of the day records, goals and rules (X-019)', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-11T10:00:00Z'));
    ddb.on(QueryCommand, { TableName: 'stats' }).resolves({ Items: [day('2026-11-03', 600), day('2026-11-10', 100), day('2026-10-28', -50)] });
    ddb.on(QueryCommand, { TableName: 'goals' }).resolves({ Items: [goal('week#2026-11-02', 'profit', 500), goal('week#2026-11-09', 'profit', 500)] });
    const res = await get('?period=week&count=2');
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.data.periods.map((p: any) => p.periodKey)).toEqual(['week#2026-11-02', 'week#2026-11-09']);
    expect(body.data.periods[0].goals.profit).toMatchObject({ current: 600, target: 500, achieved: true });
    expect(body.data.periods[1].goals.profit).toMatchObject({ current: 100, target: 500, achieved: false });
    expect(body.data.periods[0].rules).toMatchObject({ totalActiveRules: 0 });
    expect(calls('stats')).toHaveLength(1);
    expect(calls('goals')).toHaveLength(1);
    expect(calls('rules')).toHaveLength(1);
    const range = calls('stats')[0].args[0].input.ExpressionAttributeValues;
    expect(range).toMatchObject({ ':startDate': '2026-11-02', ':endDate': '2026-11-15' });
  });

  it('totalCapital is passed through: the drawdown goal is a percentage of it', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-11T10:00:00Z'));
    ddb.on(QueryCommand, { TableName: 'stats' }).resolves({ Items: [day('2026-11-10', -100, { pnlSequence: [-100] })] });
    ddb.on(QueryCommand, { TableName: 'goals' }).resolves({ Items: [goal('week#2026-11-09', 'maxDrawdown', 3)] });
    const res = await get('?period=week&count=1&totalCapital=1000');
    expect((await res.json()).data.periods[0].goals.maxDrawdown).toMatchObject({ current: 10, target: 3, achieved: false });
    const noCapital = await get('?period=week&count=1');
    expect((await noCapital.json()).data.periods[0].goals.maxDrawdown).toMatchObject({ current: 0 });
  });

  it('weeks follow the user time zone: Sunday 20:00 UTC is already Monday in Kolkata', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-15T20:00:00Z'));
    expect((await (await get('?period=week&count=1')).json()).data.periods[0].periodKey).toBe('week#2026-11-09');
    ddb.on(GetCommand).resolves({ Item: { timeZone: 'Asia/Kolkata' } });
    expect((await (await get('?period=week&count=1')).json()).data.periods[0].periodKey).toBe('week#2026-11-16');
  });

  it('before=<period key> ends the list with the period just before it (the one on screen)', async () => {
    const weeks = (await (await get('?before=week%232026-11-09&count=2')).json()).data;
    expect(weeks.period).toBe('week');
    expect(weeks.periods.map((p: any) => p.periodKey)).toEqual(['week#2026-10-26', 'week#2026-11-02']);
    const months = (await (await get('?before=month%232026-01&count=2')).json()).data;
    expect(months.period).toBe('month');
    expect(months.periods.map((p: any) => p.periodKey)).toEqual(['month#2025-11', 'month#2025-12']);
    expect((await get('?before=week%23garbage')).status).toBe(400);
    expect((await get('?before=week%232026-13-45')).status).toBe(400);
  });

  it('caps count at 12, defaults to 8, and requires authentication', async () => {
    expect((await (await get('?count=99')).json()).data.periods).toHaveLength(12);
    expect((await (await get('')).json()).data.periods).toHaveLength(8);
    setTokenVerifier({ verify: async () => Promise.reject(new Error('bad')) });
    expect((await get()).status).toBe(401);
  });
});
