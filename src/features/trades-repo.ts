import { BatchGetCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { ddb } from '../shared/dynamo';

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
  /** ISO date or instant; inclusive */
  from: string;
  to: string;
  accountId?: string | null;
}

export interface LoadedTrades {
  trades: TradeRow[];
  /** true when the range holds more than MAX_LOADED_TRADES trades: `trades` is the oldest MAX_LOADED_TRADES, so anything computed from it is partial */
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

export const dynamoTradeSource: TradeSource = {
  async loadTrades(userId, range) {
    const TRADES = env('TRADES_TABLE');
    const end = range.to.length === 10 ? `${range.to}T23:59:59.999Z` : range.to;
    const keys: { userId: string; tradeId: string }[] = [];
    let startKey: Record<string, unknown> | undefined;
    do {
      const r = await ddb.send(
        new QueryCommand({
          TableName: TRADES,
          IndexName: 'trades-by-date-gsi',
          KeyConditionExpression: 'userId = :u AND #od BETWEEN :a AND :b',
          ExpressionAttributeNames: { '#od': 'openDate' },
          ExpressionAttributeValues: { ':u': userId, ':a': range.from, ':b': end },
          ExclusiveStartKey: startKey,
        }),
      );
      for (const it of r.Items ?? []) keys.push({ userId: it.userId, tradeId: it.tradeId });
      startKey = r.LastEvaluatedKey;
    } while (startKey && keys.length < MAX_LOADED_TRADES);
    const truncated = keys.length > MAX_LOADED_TRADES || (keys.length === MAX_LOADED_TRADES && startKey !== undefined);

    const rows: TradeRow[] = [];
    for (let i = 0; i < Math.min(keys.length, MAX_LOADED_TRADES); i += 100) {
      let pending: any[] = keys.slice(i, i + 100);
      for (let attempt = 0; pending.length && attempt < 4; attempt++) {
        const r = await ddb.send(new BatchGetCommand({ RequestItems: { [TRADES]: { Keys: pending } } }));
        for (const it of r.Responses?.[TRADES] ?? []) if (!it.deletedAt) rows.push(toTradeRow(it));
        pending = r.UnprocessedKeys?.[TRADES]?.Keys ?? [];
      }
    }
    const wanted = range.accountId && range.accountId !== 'ALL' ? range.accountId : null;
    return { trades: rows.filter((t) => !wanted || t.accountId === wanted).sort((a, b) => (a.openDate < b.openDate ? -1 : 1)), truncated };
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
