import { Hono } from 'hono';
import { DAILY_STATS_PROJECTION, periodProgress, queryGoals, queryRules } from '../../handlers/get-goals-progress/app';
import { errorBody } from '../../shared/apiError';
import { queryDailyStats } from '../../shared/dailyStats';
import { dayOf, getUserTimeZone } from '../../shared/timezone';
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

const PERIOD_KEY = /^(week#\d{4}-\d{2}-\d{2}|month#\d{4}-\d{2})$/;
const DAY_MS = 86_400_000;

/**
 * GET /v1/goals/history?period=week|month&count=8[&accountId=ALL][&weekStart=mon|sun][&totalCapital=N][&before=<periodKey>]
 * Per period, the goal results and rule compliance exactly as /v1/goals/progress computes them for that period.
 * Periods are calendar weeks / months in the user's time zone; without `before` the last one is the period that holds
 * today, with it the last one is the period just before `before` (the one on screen). The DailyStats range, the
 * goals and the rules are each read once for all periods.
 */
goalsHistoryRoutes.get('/history', async (c) => {
  const before = c.req.query('before');
  if (before !== undefined && !PERIOD_KEY.test(before)) return c.json(errorBody('VALIDATION_ERROR', 'before must look like week#2026-11-09 or month#2026-11.'), 400);
  const period = before ? (before.startsWith('month#') ? 'month' : 'week') : c.req.query('period') === 'month' ? 'month' : 'week';
  const parsed = parseInt(c.req.query('count') ?? '8', 10);
  const count = Number.isFinite(parsed) ? Math.min(12, Math.max(1, parsed)) : 8;
  const accountId = c.req.query('accountId') || 'ALL';
  const weekStart = c.req.query('weekStart') === 'sun' ? 'sun' : 'mon';
  const capital = c.req.query('totalCapital') ? parseFloat(c.req.query('totalCapital')!) : undefined;
  const totalCapital = capital !== undefined && Number.isFinite(capital) ? capital : undefined;
  const userId = c.get('userId');

  let anchor: Date;
  if (before) {
    const first = Date.parse(`${before.startsWith('month#') ? `${before.slice(6)}-01` : before.slice(5)}T12:00:00Z`);
    if (Number.isNaN(first)) return c.json(errorBody('VALIDATION_ERROR', 'before must be a real period.'), 400);
    anchor = new Date(first - DAY_MS);
  } else {
    const timeZone = await getUserTimeZone(userId).catch(() => null);
    anchor = new Date(`${dayOf(new Date().toISOString(), timeZone)}T12:00:00Z`);
  }

  const windows = periodWindows(period, count, anchor, weekStart);
  const [records, goals, rules] = await Promise.all([
    queryDailyStats(userId, accountId, windows[0].startDate, windows[windows.length - 1].endDate, DAILY_STATS_PROJECTION),
    queryGoals(userId),
    queryRules(userId),
  ]);
  const periods = windows.map((w) => {
    const prefix = `${w.periodKey}#`;
    const { goalProgress, ruleCompliance } = periodProgress(
      records.filter((r) => r.date >= w.startDate && r.date <= w.endDate),
      goals.filter((g) => String(g.goalId).startsWith(prefix)),
      rules.filter((r) => String(r.ruleId).startsWith(prefix)),
      rules,
      period === 'month' ? 'monthly' : 'weekly',
      accountId,
      totalCapital,
    );
    return { ...w, goals: goalProgress, rules: ruleCompliance };
  });

  return c.json({ success: true, message: 'Success', data: { period, accountId, periods } });
});
