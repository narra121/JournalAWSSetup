import { Hono } from 'hono';
import type { AppEnv } from '../../app/types';
import { planRequired } from '../../app/billing/responses';
import { fail, ok } from '../http';
import { dynamoTradeSource, MAX_LOADED_TRADES, type TradeRow, type TradeSource } from '../trades-repo';
import { buildTaxReport, countsInFy, fyRange } from './tax';

export interface ReportDeps {
  trades: TradeSource;
}

/** Delivery trades can open long before the FY they close in; the lookback covers the long-term threshold. */
const LOOKBACK_DAYS = 400;
/** Older positions are read back this many years before the FY: one held longer than that is not in the report. */
const MAX_HOLDING_YEARS = 10;

export function reportsApp(deps: ReportDeps = { trades: dynamoTradeSource }): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.get('/tax', async (c) => {
    const ent = c.get('entitlements');
    if (!ent?.features?.tax_report) {
      return planRequired(c, 'tax_report', ent);
    }
    const fy = c.req.query('fy') ?? '';
    const range = fyRange(fy);
    if (!range) return fail(c, 400, 'VALIDATION_ERROR', 'fy must look like 2026-27.');
    const accountId = c.req.query('accountId');
    if (accountId && accountId.length > 100) return fail(c, 400, 'VALIDATION_ERROR', 'accountId is too long.');

    const from = new Date(Date.parse(`${range.from}T00:00:00Z`) - LOOKBACK_DAYS * 86_400_000).toISOString().slice(0, 10);
    const userId = c.get('userId');
    const inFy = (t: TradeRow) => countsInFy(t, range);
    const inRange = await deps.trades.loadTrades(userId, { from, to: range.to, accountId: accountId ?? null, filter: inFy });
    // A delivery position can be held for years: trades opened before the lookback that closed in this FY.
    const dayBeforeFrom = new Date(Date.parse(`${from}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
    const oldest = `${Number(range.from.slice(0, 4)) - MAX_HOLDING_YEARS}-04-01`;
    const older = await deps.trades.loadTrades(userId, { from: oldest, to: dayBeforeFrom, accountId: accountId ?? null, filter: inFy });
    const loaded = {
      trades: [...new Map([...older.trades, ...inRange.trades].map((t) => [t.id, t])).values()],
      truncated: inRange.truncated || older.truncated,
    };
    if (loaded.truncated) {
      return fail(c, 422, 'DATA_TRUNCATED', `There are more than ${MAX_LOADED_TRADES} trades in the period this report reads, so the totals would be incomplete and no report is produced. Choose a single account to reduce the number of trades.`, { limit: MAX_LOADED_TRADES });
    }
    return ok(c, { report: buildTaxReport(loaded.trades, fy, accountId && accountId !== 'ALL' ? accountId : null) });
  });

  return app;
}
