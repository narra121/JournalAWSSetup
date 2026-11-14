import { toTradeRow, type TradeRow } from '../../trades-repo';
import qa from './fixtures/qa-trades.json';

/** A trade row with every I1 field; P&L defaults to the price move × quantity minus fees. */
export function row(p: Partial<TradeRow> & { id: string; openDate: string }): TradeRow {
  const base: TradeRow = {
    id: p.id, accountId: 'acc1', symbol: 'NIFTY', side: 'BUY', quantity: 10, entryPrice: 100, exitPrice: 100, stopLoss: 95, pnl: 0, fees: 0,
    contractMultiplier: null, openDate: p.openDate, closeDate: null, setupType: null, tradingSession: null, assetClass: null, mistakes: [],
    brokenRuleIds: [], tags: [], takeProfit: null, riskRewardRatio: null, marketCondition: null, newsEvents: [], outcome: null, notes: null,
    lessons: [], optionType: null, expiry: null, reviewed: false,
  };
  const t = { ...base, ...p };
  if (p.pnl === undefined) t.pnl = (t.side === 'SELL' ? -1 : 1) * (t.exitPrice - t.entryPrice) * t.quantity - t.fees;
  return t;
}

/** `HH:MM` on a day, held `minutes`, as UTC instants. */
export const at = (day: string, hhmm: string, minutes: number) => {
  const open = `${day}T${hhmm}:00.000Z`;
  return { openDate: open, closeDate: new Date(Date.parse(open) + minutes * 60_000).toISOString() };
};

export interface QaAccount {
  accountId: string;
  name: string;
  currency: string;
  initialBalance: number;
}
export const qaAccounts = qa.accounts as QaAccount[];
export const qaTrades = (currency: 'USD' | 'INR'): TradeRow[] => {
  const acc = qaAccounts.find((a) => a.currency === currency)!;
  return (qa.trades as Record<string, unknown>[]).filter((t) => t.accountId === acc.accountId).map(toTradeRow);
};

/**
 * The behaviour fixture (UTC). Days and trade counts: 03-02 three, 03-03 two, 03-04 five, 03-05 one, 03-06 one.
 * Expected values in detectors.test.ts are worked out by hand from these rows.
 */
export function behaviourTrades(): TradeRow[] {
  return [
    row({ id: 't1', ...at('2026-03-02', '09:00', 30), entryPrice: 100, stopLoss: 95, exitPrice: 90, quantity: 20 }),
    row({ id: 't2', ...at('2026-03-02', '09:40', 20), entryPrice: 100, stopLoss: 95, exitPrice: 105, quantity: 60 }),
    row({ id: 't3', ...at('2026-03-02', '10:30', 30), entryPrice: 100, stopLoss: 95, exitPrice: 102, quantity: 20, takeProfit: 110 }),
    row({ id: 't4', ...at('2026-03-03', '09:00', 180), side: 'SELL', entryPrice: 50, stopLoss: 52, exitPrice: 53, quantity: 10 }),
    row({ id: 't5', ...at('2026-03-03', '13:00', 10), entryPrice: 100, stopLoss: null, exitPrice: 101, quantity: 10 }),
    row({ id: 't6', ...at('2026-03-04', '09:00', 10), entryPrice: 100, stopLoss: 99, exitPrice: 100.5, quantity: 10, fees: 6 }),
    row({ id: 't7', ...at('2026-03-04', '09:20', 20), entryPrice: 100, stopLoss: 99, exitPrice: 99.5, quantity: 40, brokenRuleIds: ['r1'] }),
    row({ id: 't8', ...at('2026-03-04', '10:00', 10), entryPrice: 100, stopLoss: 99, exitPrice: 99.5, quantity: 40, brokenRuleIds: ['r2'] }),
    row({ id: 't9', ...at('2026-03-04', '10:30', 10), entryPrice: 100, stopLoss: 99, exitPrice: 101, quantity: 10 }),
    row({ id: 't10', ...at('2026-03-04', '11:00', 10), entryPrice: 100, stopLoss: 99, exitPrice: 101, quantity: 10 }),
    row({ id: 't11', ...at('2026-03-05', '09:00', 60), entryPrice: 100, stopLoss: 80, exitPrice: 90, quantity: 5, assetClass: 'options', optionType: 'call', expiry: '2026-03-05' }),
    row({ id: 't12', ...at('2026-03-06', '09:00', 60), entryPrice: 100, stopLoss: 80, exitPrice: 108, quantity: 5, assetClass: 'options', optionType: 'put', expiry: '2026-03-12' }),
  ];
}
export const RULE_TEXTS = new Map([['r1', 'No revenge trades'], ['r2', 'no revenge  trades ']]);
