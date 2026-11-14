import { QueryCommand } from '@aws-sdk/lib-dynamodb';
import { ddb } from '../shared/dynamo';
import { dayOf, dayQueryRange } from '../shared/timezone';
import { loadFullRecords } from '../shared/tradeRecords';

/**
 * The Trades attributes the analysis and AI features read. Notes and lessons reach a prompt only when the user has
 * switched that on; images and account names never do.
 */
export interface TradeRow {
  id: string;
  accountId: string | null;
  symbol: string;
  side: 'BUY' | 'SELL';
  quantity: number;
  entryPrice: number;
  exitPrice: number;
  stopLoss: number | null;
  /** NET of fees (CONTRACT §6) */
  pnl: number;
  fees: number;
  contractMultiplier: number | null;
  openDate: string;
  closeDate: string | null;
  setupType: string | null;
  tradingSession: string | null;
  assetClass: string | null;
  mistakes: string[];
  brokenRuleIds: string[];
  tags: string[];
  takeProfit: number | null;
  /** planned reward ÷ risk as entered (older trades may hold the achieved ratio) */
  riskRewardRatio: number | null;
  marketCondition: string | null;
  newsEvents: string[];
  outcome: string | null;
  /** stored as `tradeNotes` */
  notes: string | null;
  lessons: string[];
  optionType: 'call' | 'put' | null;
  /** YYYY-MM-DD; for monthly contracts read from the symbol it is the month's last day, not the exchange expiry */
  expiry: string | null;
  reviewed: boolean;
}

export interface TradeRange {
  /** ISO instant, or a date (YYYY-MM-DD) meaning that whole day in `timeZone`; inclusive */
  from: string;
  to: string;
  /** IANA zone of the date bounds; null/absent = Asia/Kolkata */
  timeZone?: string | null;
  accountId?: string | null;
  /** Applied before the MAX_LOADED_TRADES cap counts a trade (for callers that only want some of the range). */
  filter?: (trade: TradeRow) => boolean;
}

export interface LoadedTrades {
  trades: TradeRow[];
  /** true when the range holds more than MAX_LOADED_TRADES matching trades (or more than MAX_SCANNED_KEYS index rows): `trades` is the oldest ones found, so anything computed from it is partial */
  truncated: boolean;
}

export interface TradeSource {
  /** Live trades only: soft-deleted ones (`deletedAt` set, including undone imports) are never returned. */
  loadTrades(userId: string, range: TradeRange): Promise<LoadedTrades>;
  /** ruleId → rule text */
  loadRuleTexts(userId: string): Promise<Map<string, string>>;
  /** idempotency keys already stored for the account, with the stored `-<accountId>` suffix removed */
  importedKeys(userId: string, accountId: string, prefix: string): Promise<Set<string>>;
}

export const MAX_LOADED_TRADES = 5000;
/** Index rows read per request. The index holds every account and soft-deleted trade, so this bounds the work, not the result. */
export const MAX_SCANNED_KEYS = 50_000;
export const DEFAULT_TIME_ZONE = 'Asia/Kolkata';
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);
const strs = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : []);
const optionType = (v: unknown): 'call' | 'put' | null => {
  const s = typeof v === 'string' ? v.trim().toLowerCase() : '';
  return s === 'call' || s === 'ce' ? 'call' : s === 'put' || s === 'pe' ? 'put' : null;
};

export function toTradeRow(it: Record<string, any>): TradeRow {
  return {
    id: String(it.tradeId),
    accountId: str(it.accountId) && it.accountId !== '-1' ? it.accountId : null,
    symbol: String(it.symbol ?? ''),
    side: it.side === 'SELL' ? 'SELL' : 'BUY',
    quantity: num(it.quantity) ?? 0,
    entryPrice: num(it.entryPrice) ?? 0,
    exitPrice: num(it.exitPrice) ?? 0,
    stopLoss: num(it.stopLoss),
    pnl: num(it.pnl) ?? 0,
    fees: num(it.fees) ?? 0,
    contractMultiplier: num(it.contractMultiplier),
    openDate: String(it.openDate ?? ''),
    closeDate: str(it.closeDate),
    setupType: str(it.setupType),
    tradingSession: str(it.tradingSession),
    assetClass: str(it.assetClass),
    mistakes: strs(it.mistakes),
    brokenRuleIds: strs(it.brokenRuleIds),
    tags: strs(it.tags),
    takeProfit: num(it.takeProfit),
    riskRewardRatio: num(it.riskRewardRatio),
    marketCondition: str(it.marketCondition),
    newsEvents: strs(it.newsEvents),
    outcome: str(it.outcome),
    notes: str(it.tradeNotes),
    lessons: strs(it.lessons),
    optionType: optionType(it.optionType),
    expiry: str(it.expiry),
    reviewed: it.reviewed === true,
  };
}

const env = (n: string) => {
  const v = process.env[n];
  if (!v) throw new Error(`${n} not configured`);
  return v;
};

const isDay = (v: string) => v.length === 10;

export const dynamoTradeSource: TradeSource = {
  /**
   * Walks the date index (keys only) in date order and loads the records in chunks. Only live trades of the requested
   * account count toward MAX_LOADED_TRADES; other accounts' and soft-deleted rows are read and dropped.
   */
  async loadTrades(userId, range) {
    const TRADES = env('TRADES_TABLE');
    const tz = range.timeZone || DEFAULT_TIME_ZONE;
    // Date bounds are whole local days. The query range can reach into the neighbouring days (date-only openDate
    // values sort before the instant of local midnight), so those rows are dropped by their local day below.
    const from = isDay(range.from) ? dayQueryRange(range.from, tz).start : range.from;
    const to = isDay(range.to) ? dayQueryRange(range.to, tz).end : range.to;
    const outside = (openDate: string) => {
      const day = dayOf(openDate, tz);
      return (isDay(range.from) && day < range.from) || (isDay(range.to) && day > range.to);
    };
    const wanted = range.accountId && range.accountId !== 'ALL' ? range.accountId : null;
    const rows: TradeRow[] = [];
    let scanned = 0;
    let truncated = false;
    let startKey: Record<string, unknown> | undefined;
    scan: do {
      const r = await ddb.send(
        new QueryCommand({
          TableName: TRADES,
          IndexName: 'trades-by-date-gsi',
          KeyConditionExpression: 'userId = :u AND #od BETWEEN :a AND :b',
          ExpressionAttributeNames: { '#od': 'openDate' },
          ExpressionAttributeValues: { ':u': userId, ':a': from, ':b': to },
          ExclusiveStartKey: startKey,
        }),
      );
      const keyRows = r.Items ?? [];
      scanned += keyRows.length;
      for (let i = 0; i < keyRows.length; i += 100) {
        const chunk = keyRows.slice(i, i + 100);
        const full = await loadFullRecords(userId, chunk);
        for (const k of chunk) {
          const it = full.get(k.tradeId);
          if (!it || it.deletedAt) continue;
          const row = toTradeRow(it);
          if (wanted && row.accountId !== wanted) continue;
          if (outside(row.openDate)) continue;
          if (range.filter && !range.filter(row)) continue;
          if (rows.length >= MAX_LOADED_TRADES) {
            truncated = true;
            break scan;
          }
          rows.push(row);
        }
      }
      startKey = r.LastEvaluatedKey;
      if (startKey && scanned >= MAX_SCANNED_KEYS) truncated = true;
    } while (startKey && !truncated);
    return { trades: rows.sort((a, b) => (a.openDate < b.openDate ? -1 : 1)), truncated };
  },

  async loadRuleTexts(userId) {
    const out = new Map<string, string>();
    let startKey: Record<string, unknown> | undefined;
    do {
      const r = await ddb.send(
        new QueryCommand({ TableName: env('RULES_TABLE'), KeyConditionExpression: 'userId = :u', ExpressionAttributeValues: { ':u': userId }, ExclusiveStartKey: startKey }),
      );
      for (const it of r.Items ?? []) if (typeof it.rule === 'string') out.set(String(it.ruleId), it.rule);
      startKey = r.LastEvaluatedKey;
    } while (startKey);
    return out;
  },

  async importedKeys(userId, accountId, prefix) {
    const out = new Set<string>();
    const suffix = `-${accountId}`;
    let startKey: Record<string, unknown> | undefined;
    do {
      const r = await ddb.send(
        new QueryCommand({
          TableName: env('TRADES_TABLE'),
          IndexName: 'user-idempotency-gsi',
          KeyConditionExpression: 'userId = :u AND begins_with(idempotencyKey, :p)',
          ExpressionAttributeValues: { ':u': userId, ':p': prefix },
          ExclusiveStartKey: startKey,
        }),
      );
      for (const it of r.Items ?? []) {
        const k = String(it.idempotencyKey);
        out.add(k.endsWith(suffix) ? k.slice(0, -suffix.length) : k);
      }
      startKey = r.LastEvaluatedKey;
    } while (startKey);
    return out;
  },
};
