import { QueryCommand } from '@aws-sdk/lib-dynamodb';
import { ddb } from '../shared/dynamo';
import { loadFullRecords } from '../shared/tradeRecords';

/** The Trades attributes the AI features read. Notes, lessons, images and account names are never loaded into prompts. */
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
}

export interface TradeRange {
  /** ISO instant, or a date (YYYY-MM-DD) meaning that whole IST day; inclusive */
  from: string;
  to: string;
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
const IST_OFFSET = '+05:30';
const DAY_MS = 86_400_000;
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);

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
    mistakes: Array.isArray(it.mistakes) ? it.mistakes.map(String) : [],
    brokenRuleIds: Array.isArray(it.brokenRuleIds) ? it.brokenRuleIds.map(String) : [],
    tags: Array.isArray(it.tags) ? it.tags.map(String) : [],
  };
}

const env = (n: string) => {
  const v = process.env[n];
  if (!v) throw new Error(`${n} not configured`);
  return v;
};

/** A date bound is an IST calendar day (the day every metric and report uses); an instant is used as it is. */
function istBound(value: string, edge: 'start' | 'end'): string {
  if (value.length !== 10) return value;
  const start = Date.parse(`${value}T00:00:00${IST_OFFSET}`);
  return new Date(edge === 'start' ? start : start + DAY_MS - 1).toISOString();
}

export const dynamoTradeSource: TradeSource = {
  /**
   * Walks the date index (keys only) in date order and loads the records in chunks. Only live trades of the requested
   * account count toward MAX_LOADED_TRADES; other accounts' and soft-deleted rows are read and dropped.
   */
  async loadTrades(userId, range) {
    const TRADES = env('TRADES_TABLE');
    const from = istBound(range.from, 'start');
    const to = istBound(range.to, 'end');
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
      for (const it of r.Items ?? []) if (typeof it.text === 'string') out.set(String(it.ruleId), it.text);
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
