import type { Row } from './csv';

export type AssetClass = 'stock' | 'forex' | 'futures' | 'options' | 'crypto' | 'cfd' | 'commodity';
export type SourceId = 'zerodha' | 'zerodha_pnl' | 'dhan' | 'upstox' | 'angelone' | 'groww' | 'mt4' | 'mt5' | 'generic_csv';
export type BrokerPlan = 'zerodha' | 'dhan' | 'upstox' | 'angelone' | 'groww';

/** Instrument fields shared by fills and trades (CONTRACT §6 names). */
export interface Instrument {
  symbol: string;
  assetClass: AssetClass;
  exchange?: string;
  isin?: string;
  underlying?: string;
  optionType?: 'call' | 'put';
  strike?: number;
  /** ISO date YYYY-MM-DD */
  expiry?: string;
  /** Lot size / contract size used for P&L; undefined = 1 (quantities are already in units). */
  contractMultiplier?: number;
}

/** One execution from a tradebook or broker API. */
export interface Fill extends Instrument {
  side: 'BUY' | 'SELL';
  /** units (shares / contracts × lot size), always > 0 */
  quantity: number;
  price: number;
  /** UTC ISO */
  time: string;
  /** broker trade id; dedupe key within a file */
  tradeId: string;
  /** order id; brokerage is charged per executed order */
  orderId?: string;
}

/** Charges breakdown in account currency (positive = cost). */
export interface Charges {
  brokerage: number;
  stt: number;
  exchange: number;
  sebi: number;
  stamp: number;
  gst: number;
  other: number;
}

/** Trade-create body (src/schemas/trade-create.schema.json) + CONTRACT §6 fields. */
export interface NormalizedTrade {
  symbol: string;
  side: 'BUY' | 'SELL';
  quantity: number;
  entryPrice: number;
  exitPrice: number;
  openDate: string;
  closeDate: string;
  outcome: 'TP' | 'SL' | 'BREAKEVEN';
  /** NET of fees */
  pnl: number;
  stopLoss: number | null;
  takeProfit: number | null;
  tags: string[];
  assetClass: AssetClass;
  fees: number;
  grossPnl: number;
  contractMultiplier?: number;
  underlying?: string;
  optionType?: 'call' | 'put';
  strike?: number;
  expiry?: string;
  externalId: string;
  importSource: SourceId;
  /** Response-only: estimated or actual charge breakdown. */
  charges?: Charges;
  /** Response-only: whether `charges` are estimates. */
  chargesEstimated?: boolean;
  /** Response-only: executions combined into this trade. */
  fills?: number;
  /** Response-only: already imported into the requested account. */
  duplicate?: boolean;
}

/** A broker row that is already a closed position (MT4/MT5, P&L summaries, generic CSV with entry+exit). */
export interface ClosedTrade extends Instrument {
  side: 'BUY' | 'SELL';
  quantity: number;
  entryPrice: number;
  exitPrice: number;
  openTime: string;
  closeTime: string;
  externalId: string;
  /** Broker-reported gross profit (before fees) when the file has it. */
  grossProfit?: number;
  /** Actual costs from the file (positive = cost). */
  fees?: number;
  charges?: Charges;
  stopLoss?: number | null;
  takeProfit?: number | null;
}

export interface Tabular {
  /** CSV → one sheet; XLSX → each sheet; HTML → all <tr> rows */
  sheets: { name: string; rows: Row[] }[];
  kind: 'csv' | 'xlsx' | 'html';
  fileName: string;
}

export interface ParseContext {
  utcOffsetMinutes: number;
  mapping?: Partial<Record<CanonicalField, string>>;
  warnings: string[];
}

export type CanonicalField =
  | 'symbol' | 'side' | 'quantity' | 'price' | 'time' | 'date' | 'tradeId' | 'orderId'
  | 'entryPrice' | 'exitPrice' | 'openTime' | 'closeTime' | 'pnl' | 'fees' | 'stopLoss' | 'takeProfit';

export type ParserOutput =
  | { kind: 'fills'; fills: Fill[]; skipped: number; plan?: BrokerPlan }
  | { kind: 'closed'; trades: ClosedTrade[]; skipped: number }
  | { kind: 'needsMapping'; headers: string[]; suggested: Partial<Record<CanonicalField, string>> };

export interface ImportParser {
  id: SourceId;
  name: string;
  assetClasses: AssetClass[];
  fileTypes: string[];
  howToExport: string;
  sampleColumns: string[];
  /** Default wall-clock offset of the file's times (IST for Indian brokers). */
  defaultUtcOffsetMinutes: number;
  /** 0 = not this format; higher = more specific match. Pure, cheap. */
  detect(t: Tabular): number;
  parse(t: Tabular, ctx: ParseContext): ParserOutput;
}

/** Live broker connection state persisted by a future sync feature (tokens stored encrypted, never logged). */
export interface SyncConnection {
  provider: SyncProvider['id'];
  userId: string;
  accountId: string;
  /** opaque provider credentials (access token, expiry, client id) */
  credentials: Record<string, string>;
  /** UTC ISO; after this the user must re-authorise (e.g. Kite tokens expire daily) */
  expiresAt?: string;
  lastSyncedAt?: string;
}

/**
 * Future live sync. Implementations return the same `Fill` the file parsers produce, so API and file imports
 * share round-trip building, charges and dedupe (externalId). Constraints per broker: design/features.md §8.
 */
export interface SyncProvider {
  id: 'zerodha' | 'dhan' | 'upstox' | 'angelone' | 'groww' | 'mt5';
  /** Start authorisation: an OAuth/redirect URL, or a ready connection for token-paste flows. */
  connect(userId: string, accountId: string, redirectUri: string): Promise<{ authUrl: string } | { connection: SyncConnection }>;
  /** Finish the redirect flow with the provider's callback params (request_token, code, …). */
  completeConnect(userId: string, accountId: string, params: Record<string, string>): Promise<SyncConnection>;
  /** Renew credentials where the provider allows it; throws SyncAuthRequired when the user must log in again. */
  refresh(conn: SyncConnection): Promise<SyncConnection>;
  /** Executions since `sinceIso` (UTC), oldest first. Providers limited to "today" return only today's fills. */
  fetchTrades(conn: SyncConnection, sinceIso: string): Promise<Fill[]>;
}

export class SyncAuthRequired extends Error {}
