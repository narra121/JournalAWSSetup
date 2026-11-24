import { createHash } from 'node:crypto';
import { computePnl, outcomeFromPnl } from '../pnl';
import { estimateCharges, totalCharges } from './charges/india';
import { decodeFile } from './decode';
import { detectParser } from './detect';
import { parserById } from './registry';
import { buildEpisodes, type Episode } from './roundtrip';
import type { CanonicalField, Charges, ClosedTrade, NormalizedTrade, ParserOutput, SourceId } from './types';
import { FileFormatError } from './xlsx';

export const MAX_TRADES = 5000;

export interface ParseRequest {
  source: SourceId | 'auto';
  fileName: string;
  contentBase64: string;
  utcOffsetMinutes?: number;
  timeZone?: string;
  mapping?: Partial<Record<CanonicalField, string>>;
}

export interface ParseResponse {
  detectedSource: SourceId | 'unknown';
  trades: NormalizedTrade[];
  warnings: string[];
  skipped: number;
  columns?: { headers: string[]; suggested: Partial<Record<CanonicalField, string>> };
  /** SHA-256 of the decoded file; identifies a re-parse of the same file (BE-R13). Not part of the API response. */
  fileHash: string;
}

const closedToTrade = (c: ClosedTrade, source: SourceId): NormalizedTrade => {
  const fees = c.charges ? totalCharges(c.charges) : c.fees ?? 0;
  const r = computePnl({
    side: c.side, quantity: c.quantity, entryPrice: c.entryPrice, exitPrice: c.exitPrice,
    multiplier: c.contractMultiplier, fees, grossOverride: c.grossProfit, stopLoss: c.stopLoss,
  });
  return {
    symbol: c.symbol, side: c.side, quantity: c.quantity, entryPrice: c.entryPrice, exitPrice: c.exitPrice,
    openDate: c.openTime, closeDate: c.closeTime, outcome: outcomeFromPnl(r.netPnl), pnl: r.netPnl,
    stopLoss: c.stopLoss ?? null, takeProfit: c.takeProfit ?? null, tags: [], assetClass: c.assetClass,
    fees: r.fees, grossPnl: r.grossPnl, ...(c.contractMultiplier ? { contractMultiplier: c.contractMultiplier } : {}),
    ...(c.underlying ? { underlying: c.underlying } : {}), ...(c.optionType ? { optionType: c.optionType } : {}),
    ...(c.strike != null ? { strike: c.strike } : {}), ...(c.expiry ? { expiry: c.expiry } : {}),
    externalId: `${source}:${c.externalId}`, importSource: source, ...(c.charges ? { charges: c.charges } : {}),
  };
};

/** The charges the file listed for every leg of the episode, summed; null when any leg has none. */
function listedCharges(e: Episode): Charges | null {
  if (!e.legs.length || !e.legs.every((l) => l.charges)) return null;
  const r2 = (x: number) => Math.round((x + Number.EPSILON) * 100) / 100;
  const sum = (k: keyof Charges) => r2(e.legs.reduce((a, l) => a + l.charges![k], 0));
  return { brokerage: sum('brokerage'), stt: sum('stt'), exchange: sum('exchange'), sebi: sum('sebi'), stamp: sum('stamp'), gst: sum('gst'), other: sum('other') };
}

function fillsToTrades(out: Extract<ParserOutput, { kind: 'fills' }>, source: SourceId, warnings: string[]): NormalizedTrade[] {
  const rt = buildEpisodes(out.fills);
  if (rt.unmatchedFills) warnings.push(`${rt.unmatchedFills} closing fills had no opening fill in this file (position opened before the first date in the file). Include earlier dates to import them.`);
  if (rt.openPositions) warnings.push(`${rt.openPositions} positions are still open at the end of the file and were skipped.`);
  if (rt.expiredClosed) warnings.push(`${rt.expiredClosed} bought options expired with no closing trade; they are recorded as closed at 0.`);

  const estimated: (Charges | null)[] = out.plan ? estimateCharges(rt.episodes, out.plan) : rt.episodes.map(() => null);
  const listed = rt.episodes.map(listedCharges);
  if (estimated.some((c, i) => c && !listed[i])) {
    warnings.push("Charges are estimated from statutory rates in force on each trade date and the broker's standard brokerage plan; your contract note is authoritative.");
  }
  return rt.episodes.map((e, i) => {
    const mult = e.instrument.contractMultiplier;
    const c = listed[i] ?? estimated[i];
    const fees = c ? totalCharges(c) : 0;
    const r = computePnl({
      side: e.side, quantity: e.quantity, entryPrice: e.entryPrice, exitPrice: e.exitPrice,
      multiplier: mult, fees, grossOverride: e.grossPoints * (mult ?? 1),
    });
    const i2 = e.instrument;
    return {
      symbol: i2.symbol, side: e.side, quantity: e.quantity, entryPrice: e.entryPrice, exitPrice: e.exitPrice,
      openDate: e.openTime, closeDate: e.closeTime, outcome: outcomeFromPnl(r.netPnl), pnl: r.netPnl,
      stopLoss: null, takeProfit: null, tags: [], assetClass: i2.assetClass, fees: r.fees, grossPnl: r.grossPnl,
      ...(mult ? { contractMultiplier: mult } : {}),
      ...(i2.underlying ? { underlying: i2.underlying } : {}), ...(i2.optionType ? { optionType: i2.optionType } : {}),
      ...(i2.strike != null ? { strike: i2.strike } : {}), ...(i2.expiry ? { expiry: i2.expiry } : {}),
      externalId: `${source}:${e.firstFillId}:${e.lastFillId}`, importSource: source,
      ...(c ? { charges: c, chargesEstimated: !listed[i] } : {}), fills: e.fills,
    };
  });
}

export function parseImport(req: ParseRequest): ParseResponse {
  const fileHash = createHash('sha256').update(Buffer.from(req.contentBase64, 'base64')).digest('hex');
  const warnings: string[] = [];
  let table;
  try {
    table = decodeFile(req.contentBase64, req.fileName);
  } catch (e) {
    if (e instanceof FileFormatError) return { detectedSource: 'unknown', trades: [], warnings: [e.message], skipped: 0, fileHash };
    throw e;
  }

  const parser = req.source === 'auto' ? detectParser(table) : parserById(req.source);
  if (!parser) {
    return {
      detectedSource: 'unknown', trades: [], skipped: 0, fileHash,
      warnings: ['This file does not match a supported broker format. Choose your broker, use "Other broker (CSV / Excel)", or try AI extraction.'],
    };
  }
  if (req.source !== 'auto' && parser.id !== 'generic_csv' && parser.detect(table) === 0) {
    return { detectedSource: 'unknown', trades: [], skipped: 0, fileHash, warnings: [`This file does not look like a ${parser.name} export. Check the source or let the app detect it.`] };
  }

  const ctx = { utcOffsetMinutes: req.utcOffsetMinutes ?? parser.defaultUtcOffsetMinutes, timeZone: req.timeZone, mapping: req.mapping, warnings };
  const out = parser.parse(table, ctx);
  if (out.kind === 'needsMapping') {
    return { detectedSource: parser.id, trades: [], skipped: 0, fileHash, warnings, columns: { headers: out.headers, suggested: out.suggested } };
  }

  const source = parser.id;
  let trades = out.kind === 'fills' ? fillsToTrades(out, source, warnings) : out.trades.map((c) => closedToTrade(c, source));

  const seen = new Set<string>();
  let dropped = 0;
  trades = trades.filter((t) => (seen.has(t.externalId) ? (dropped++, false) : (seen.add(t.externalId), true)));
  trades.sort((a, b) => (a.openDate < b.openDate ? -1 : a.openDate > b.openDate ? 1 : 0));
  if (trades.length > MAX_TRADES) {
    warnings.push(`The file has ${trades.length} trades; only the first ${MAX_TRADES} are returned. Import a shorter date range for the rest.`);
    trades = trades.slice(0, MAX_TRADES);
  }
  if (!trades.length) warnings.push('No complete trades were found in this file.');
  return { detectedSource: source, trades, warnings, skipped: out.skipped + dropped, fileHash };
}

/** Idempotency key the frontend sends on save and the duplicate check looks up (design §2.1). */
export const importKeyPrefix = (accountId: string) => `imp|${accountId}|`;
export const importKey = (accountId: string, t: Pick<NormalizedTrade, 'importSource' | 'externalId'>) =>
  `${importKeyPrefix(accountId)}${t.importSource}|${t.externalId}`;

