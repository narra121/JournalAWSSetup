import { describe, expect, it, vi } from 'vitest';

vi.stubEnv('USER_POOL_ID', 'us-east-1_t');
vi.stubEnv('USER_POOL_CLIENT_ID', 'c');
vi.stubEnv('ALLOWED_ORIGINS', 'https://dev.tradequt.com');

const progress = vi.fn();
vi.mock('../../handlers/get-goals-progress/app', () => ({ handler: (e: any) => progress(e) }));

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

  it('returns each period with the goal results and rule compliance from /goals/progress', async () => {
    setTokenVerifier({ verify: async () => ({ sub: 'u1' }) });
    progress.mockReset().mockImplementation(async (e: any) => ({
      statusCode: 200,
      body: JSON.stringify({ data: { goalProgress: { profit: { achieved: e.queryStringParameters.periodKey.endsWith('09') } }, ruleCompliance: { brokenCount: 1 } } }),
    }));
    const res = await get('?period=week&count=2');
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.data.periods).toHaveLength(2);
    expect(body.data.periods[0]).toMatchObject({ rules: { brokenCount: 1 }, goals: { profit: { achieved: false } } });
    const first = progress.mock.calls[0][0];
    expect(first.queryStringParameters).toMatchObject({ accountId: 'ALL', period: 'weekly' });
    expect(first.requestContext.authorizer.jwt.claims.sub).toBe('u1');
  });

  it('caps count at 12, defaults to 8, and requires authentication', async () => {
    setTokenVerifier({ verify: async () => ({ sub: 'u1' }) });
    progress.mockReset().mockResolvedValue({ statusCode: 200, body: JSON.stringify({ data: { goalProgress: {}, ruleCompliance: {} } }) });
    expect((await (await get('?count=99')).json()).data.periods).toHaveLength(12);
    expect((await (await get('')).json()).data.periods).toHaveLength(8);
    setTokenVerifier({ verify: async () => Promise.reject(new Error('bad')) });
    expect((await get()).status).toBe(401);
  });
});
