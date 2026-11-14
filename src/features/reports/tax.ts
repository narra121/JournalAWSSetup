import { round2 } from '../pnl';
import { ratesFor, segmentOf } from '../import/charges/india';
import { istDate } from '../import/table';
import type { TradeRow } from '../trades-repo';

/** Rules that change by financial year. Add a row; never edit an old one. */
export interface TaxRules {
  /** equity delivery is long-term after this many days */
  longTermDays: number;
  /** FY turnover above which a tax audit is considered (digital-receipts limit, ₹) */
  auditTurnoverThreshold: number;
}
export const TAX_RULES: Record<string, TaxRules> = {
  default: { longTermDays: 365, auditTurnoverThreshold: 100_000_000 },
};
const rulesFor = (fy: string): TaxRules => TAX_RULES[fy] ?? TAX_RULES.default;

export interface Bucket {
  trades: number;
  wins: number;
  losses: number;
  grossPnl: number;
  fees: number;
  netPnl: number;
}

export interface TaxReport {
  fy: string;
  period: { from: string; to: string };
  accountId: string | null;
  /** Intraday equity: speculative business income (Section 43(5)). */
  intradayEquity: Bucket;
  /** Futures and options: non-speculative business income. */
  fno: Bucket & { turnover: number; auditThreshold: number; auditThresholdExceeded: boolean };
  /** Commodity derivatives: non-speculative business income. */
  commodity: Bucket;
  /** Equity delivery by holding period. */
  delivery: { shortTerm: Bucket; longTerm: Bucket };
  /** Forex, crypto and CFD trades are not covered by this report. */
  notCovered: { trades: number; netPnl: number };
  charges: { total: number; stt: number; exchange: number; sebi: number; stamp: number; brokerageGstAndOther: number };
  warnings: string[];
}

export function fyRange(fy: string): { from: string; to: string } | null {
  const m = /^(\d{4})-(\d{2})$/.exec(fy);
  if (!m) return null;
  const start = Number(m[1]);
  if (Number(m[2]) !== (start + 1) % 100 || start < 2000 || start > 2100) return null;
  return { from: `${start}-04-01`, to: `${start + 1}-03-31` };
}

/** A trade counts in the FY of its close day (IST), or of its open day while it has no close. */
export const countsInFy = (t: Pick<TradeRow, 'openDate' | 'closeDate'>, period: { from: string; to: string }): boolean => {
  const day = istDate(t.closeDate ?? t.openDate);
  return day >= period.from && day <= period.to;
};

const empty = (): Bucket => ({ trades: 0, wins: 0, losses: 0, grossPnl: 0, fees: 0, netPnl: 0 });
const addTo = (b: Bucket, t: TradeRow) => {
  const gross = t.pnl + t.fees;
  b.trades++;
  b.wins += t.pnl > 0 ? 1 : 0;
  b.losses += t.pnl < 0 ? 1 : 0;
  b.grossPnl += gross;
  b.fees += t.fees;
  b.netPnl += t.pnl;
};
const finish = (b: Bucket): Bucket => ({ ...b, grossPnl: round2(b.grossPnl), fees: round2(b.fees), netPnl: round2(b.netPnl) });

const daysBetween = (a: string, b: string) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);

/** Statutory charges for one closed trade (open leg + close leg), brokerage excluded. NSE rates are assumed. */
function statutory(t: TradeRow, intraday: boolean) {
  const seg = segmentOf({ assetClass: (t.assetClass ?? 'stock') as never }, intraday ? 'intraday' : 'delivery');
  const legs = [
    { side: t.side, price: t.entryPrice, date: istDate(t.openDate) },
    { side: t.side === 'BUY' ? 'SELL' : 'BUY', price: t.exitPrice, date: istDate(t.closeDate ?? t.openDate) },
  ] as const;
  let stt = 0, exchange = 0, sebi = 0, stamp = 0;
  for (const l of legs) {
    const value = l.price * t.quantity * (t.contractMultiplier ?? 1);
    const r = ratesFor(l.date);
    stt += value * r.stt[seg][l.side === 'BUY' ? 'buy' : 'sell'];
    exchange += value * r.exchange[seg].nse;
    sebi += value * r.sebi;
    stamp += l.side === 'BUY' ? value * r.stamp[seg] : 0;
  }
  return { stt, exchange, sebi, stamp };
}

/** Trades closed in the FY → category totals, F&O turnover and charge breakdown. Pure. */
export function buildTaxReport(trades: TradeRow[], fy: string, accountId: string | null): TaxReport {
  const period = fyRange(fy)!;
  const rules = rulesFor(fy);
  const intraday = empty(), fnoB = empty(), commodity = empty(), st = empty(), lt = empty();
  let turnover = 0;
  let notCoveredCount = 0, notCoveredNet = 0;
  const stat = { stt: 0, exchange: 0, sebi: 0, stamp: 0 };
  let totalFees = 0;

  for (const t of trades) {
    if (!countsInFy(t, period)) continue;
    const closeIst = istDate(t.closeDate ?? t.openDate);
    const cls = t.assetClass ?? 'stock';
    const openIst = istDate(t.openDate);
    let sameDay = openIst === closeIst;

    if (cls === 'stock') {
      sameDay ? addTo(intraday, t) : addTo(daysBetween(openIst, closeIst) > rules.longTermDays ? lt : st, t);
    } else if (cls === 'futures' || cls === 'options') {
      addTo(fnoB, t);
      turnover += Math.abs(t.pnl + t.fees);
      if (cls === 'options') turnover += (t.side === 'SELL' ? t.entryPrice : t.exitPrice) * t.quantity * (t.contractMultiplier ?? 1);
      sameDay = true;
    } else if (cls === 'commodity') {
      addTo(commodity, t);
      sameDay = true;
    } else {
      notCoveredCount++;
      notCoveredNet += t.pnl;
      continue;
    }
    const s = statutory(t, cls === 'stock' ? sameDay : true);
    stat.stt += s.stt; stat.exchange += s.exchange; stat.sebi += s.sebi; stat.stamp += s.stamp;
    totalFees += t.fees;
  }

  const statTotal = stat.stt + stat.exchange + stat.sebi + stat.stamp;
  const warnings = [
    'Estimates from your journal: intraday and F&O results use trade-level P&L; confirm figures and tax treatment with your chartered accountant before filing.',
    'Charges are split using statutory rates in force on each trade date (NSE rates assumed); brokerage, GST and other charges are the remainder of the fees recorded on your trades.',
  ];
  if (fnoB.trades) warnings.push('F&O turnover follows the ICAI guidance (absolute profits and losses, plus premium on the sale leg of options).');
  if (notCoveredCount) warnings.push(`${notCoveredCount} forex, crypto or CFD trades are not covered by this report.`);

  return {
    fy,
    period,
    accountId,
    intradayEquity: finish(intraday),
    fno: { ...finish(fnoB), turnover: round2(turnover), auditThreshold: rules.auditTurnoverThreshold, auditThresholdExceeded: turnover > rules.auditTurnoverThreshold },
    commodity: finish(commodity),
    delivery: { shortTerm: finish(st), longTerm: finish(lt) },
    notCovered: { trades: notCoveredCount, netPnl: round2(notCoveredNet) },
    charges: {
      total: round2(totalFees),
      stt: round2(stat.stt), exchange: round2(stat.exchange), sebi: round2(stat.sebi), stamp: round2(stat.stamp),
      brokerageGstAndOther: round2(Math.max(0, totalFees - statTotal)),
    },
    warnings,
  };
}
