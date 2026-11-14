import { Hono } from 'hono';
import type { AppEnv } from '../../app/types';
import { tradeFacts } from '../analysis/facts';
import { resolveTimeZone } from '../analysis/load';
import { fail, ok, readJson } from '../http';
import type { AiStore } from '../store';
import type { TradeRow, TradeSource } from '../trades-repo';
import { dayOf } from '../../shared/timezone';
import { focusCheck, focusRuleText, MAX_FOCUS_TEXT, parseFocusRule } from './rules';
import { deleteFocus, getFocus, putFocus } from './store';
import type { Focus } from './types';

export interface FocusDeps {
  store: AiStore;
  trades: TradeSource;
  timeZone(userId: string): Promise<string | null>;
  now: () => Date;
}

const DAY_MS = 86_400_000;
/** Context before the start: the trader's usual risk (maxRiskMultiple) and the earlier trades of the first day. */
const CONTEXT_DAYS = 90;
const MAX_IDS = 100;
const addDays = (day: string, n: number) => new Date(Date.parse(`${day}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);

/** Kept/broken since the focus started, over every account. Counts only: amounts would add up currencies. */
async function progress(deps: FocusDeps, userId: string, focus: Focus) {
  const timeZone = resolveTimeZone(await deps.timeZone(userId));
  const start = dayOf(focus.startedAt, timeZone);
  const today = dayOf(deps.now().toISOString(), timeZone);
  if (start > today) return { checked: 0, kept: 0, broken: 0, brokenTradeIds: [] as string[], truncated: false };
  const [before, since] = await Promise.all([
    deps.trades.loadTrades(userId, { from: addDays(start, -CONTEXT_DAYS), to: addDays(start, -1), timeZone, accountId: null }),
    deps.trades.loadTrades(userId, { from: start, to: today, timeZone, accountId: null }),
  ]);
  const rows = new Map<string, TradeRow>([...before.trades, ...since.trades].map((t) => [t.id, t]));
  const startMs = Date.parse(focus.startedAt);
  const { checked, kept, broken, brokenTradeIds } = focusCheck(tradeFacts([...rows.values()], timeZone), focus.rule, (f) => f.openMs >= startMs);
  return { checked, kept, broken, brokenTradeIds: brokenTradeIds.slice(-MAX_IDS), truncated: since.truncated };
}

/** `GET/PUT/DELETE /v1/insights/focus`: the one active focus rule (CONTRACT I6). */
export function focusApp(deps: FocusDeps): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.get('/', async (c) => {
    const userId = c.get('userId');
    const focus = await getFocus(deps.store, userId);
    return ok(c, { focus, progress: focus ? await progress(deps, userId, focus) : null });
  });

  app.put('/', async (c) => {
    const body = await readJson(c);
    if (!body) return fail(c, 400, 'VALIDATION_ERROR', 'Send {rule, text?, findingKey?}.');
    const rule = parseFocusRule(body.rule);
    if (typeof rule === 'string') return fail(c, 400, 'VALIDATION_ERROR', rule);
    if (body.text != null && (typeof body.text !== 'string' || !body.text.trim() || body.text.length > MAX_FOCUS_TEXT)) return fail(c, 400, 'VALIDATION_ERROR', `text must be 1 to ${MAX_FOCUS_TEXT} characters.`);
    if (body.findingKey != null && (typeof body.findingKey !== 'string' || body.findingKey.length > 200)) return fail(c, 400, 'VALIDATION_ERROR', 'findingKey must be a finding key.');
    const focus: Focus = {
      rule,
      text: typeof body.text === 'string' ? body.text.replace(/\s+/g, ' ').trim() : focusRuleText(rule),
      startedAt: deps.now().toISOString(),
      findingKey: typeof body.findingKey === 'string' ? body.findingKey : null,
    };
    await putFocus(deps.store, c.get('userId'), focus);
    return ok(c, { focus });
  });

  app.delete('/', async (c) => {
    await deleteFocus(deps.store, c.get('userId'));
    return ok(c, { deleted: true });
  });

  return app;
}
