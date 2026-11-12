import { Hono } from 'hono';
import { handler as goalsProgress } from '../../handlers/get-goals-progress/app';
import type { AppEnv } from '../types';

export const goalsHistoryRoutes = new Hono<AppEnv>();

const iso = (d: Date) => d.toISOString().slice(0, 10);

export interface PeriodWindow {
  periodKey: string;
  startDate: string;
  endDate: string;
}

/** The `count` periods ending with the one that contains `now`, oldest first. Week keys use `week#<first day>`. */
export function periodWindows(period: 'week' | 'month', count: number, now: Date, weekStart: 'mon' | 'sun' = 'mon'): PeriodWindow[] {
  const windows: PeriodWindow[] = [];
  if (period === 'month') {
    for (let i = count - 1; i >= 0; i--) {
      const first = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
      const last = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0));
      windows.push({ periodKey: `month#${iso(first).slice(0, 7)}`, startDate: iso(first), endDate: iso(last) });
    }
    return windows;
  }
  const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const offset = (today.getUTCDay() - (weekStart === 'mon' ? 1 : 0) + 7) % 7;
  for (let i = count - 1; i >= 0; i--) {
    const first = new Date(today.getTime() - (offset + 7 * i) * 86400000);
    const last = new Date(first.getTime() + 6 * 86400000);
    windows.push({ periodKey: `week#${iso(first)}`, startDate: iso(first), endDate: iso(last) });
  }
  return windows;
}

/**
 * GET /v1/goals/history?period=week|month&count=8[&accountId=ALL][&weekStart=mon|sun]
 * Per period, the goal results and rule compliance exactly as /v1/goals/progress computes them for that period.
 */
goalsHistoryRoutes.get('/history', async (c) => {
  const period = c.req.query('period') === 'month' ? 'month' : 'week';
  const parsed = parseInt(c.req.query('count') ?? '8', 10);
  const count = Number.isFinite(parsed) ? Math.min(12, Math.max(1, parsed)) : 8;
  const accountId = c.req.query('accountId') || 'ALL';
  const weekStart = c.req.query('weekStart') === 'sun' ? 'sun' : 'mon';
  const claims = c.get('claims') ?? { sub: c.get('userId') };

  const windows = periodWindows(period, count, new Date(), weekStart);
  const periods = await Promise.all(
    windows.map(async (w) => {
      const res: any = await goalsProgress(
        {
          requestContext: { requestId: c.get('requestId'), authorizer: { jwt: { claims } } },
          queryStringParameters: {
            accountId,
            startDate: w.startDate,
            endDate: w.endDate,
            period: period === 'month' ? 'monthly' : 'weekly',
            periodKey: w.periodKey,
          },
        } as any,
        {} as any,
        () => undefined,
      );
      const body = JSON.parse(res.body);
      if (res.statusCode >= 400) throw new Error(body.message || 'goals progress failed');
      const { goalProgress, ruleCompliance } = body.data;
      return { ...w, goals: goalProgress, rules: ruleCompliance };
    }),
  );

  return c.json({ success: true, message: 'Success', data: { period, accountId, periods } });
});
