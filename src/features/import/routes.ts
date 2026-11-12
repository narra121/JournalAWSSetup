import { Hono } from 'hono';
import type { AppEnv } from '../../app/types';
import { fail, ok, quotaFail, readJson } from '../http';
import { dynamoAiStore, type AiStore } from '../store';
import { dynamoTradeSource, type TradeSource } from '../trades-repo';
import { SOURCE_IDS, sourcesMetadata } from './registry';
import { importKey, importKeyPrefix, parseImport } from './service';
import type { CanonicalField, SourceId } from './types';

/** A re-parse of the same file within this window (other account or mapping) does not use another import unit. */
export const REPARSE_WINDOW_MS = 30 * 60 * 1000;
const MAX_BASE64_CHARS = 5_600_000;
const CANONICAL: CanonicalField[] = ['symbol', 'side', 'quantity', 'price', 'time', 'date', 'tradeId', 'orderId', 'entryPrice', 'exitPrice', 'openTime', 'closeTime', 'pnl', 'fees', 'stopLoss', 'takeProfit'];

export interface ImportDeps {
  store: AiStore;
  trades: TradeSource;
  now: () => Date;
}

export const defaultImportDeps: ImportDeps = { store: dynamoAiStore, trades: dynamoTradeSource, now: () => new Date() };

export function importApp(deps: ImportDeps = defaultImportDeps): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.get('/sources', (c) => ok(c, { sources: sourcesMetadata() }));

  app.post('/parse', async (c) => {
    const body = await readJson(c);
    if (!body) return fail(c, 400, 'VALIDATION_ERROR', 'Request body must be a JSON object.');
    const { source, fileName, contentBase64, accountId, utcOffsetMinutes, mapping } = body;
    if (source !== 'auto' && !SOURCE_IDS.includes(source as SourceId)) return fail(c, 400, 'VALIDATION_ERROR', 'Unknown source.');
    if (typeof fileName !== 'string' || !fileName || fileName.length > 255) return fail(c, 400, 'VALIDATION_ERROR', 'fileName is required (max 255 characters).');
    if (typeof contentBase64 !== 'string' || !contentBase64) return fail(c, 400, 'VALIDATION_ERROR', 'contentBase64 is required.');
    if (contentBase64.length > MAX_BASE64_CHARS) return fail(c, 413, 'FILE_TOO_LARGE', 'The file is larger than 4 MB. Export a shorter date range.');
    if (accountId != null && (typeof accountId !== 'string' || !accountId || accountId.length > 100)) return fail(c, 400, 'VALIDATION_ERROR', 'accountId must be a non-empty string.');
    if (utcOffsetMinutes != null && (typeof utcOffsetMinutes !== 'number' || !Number.isFinite(utcOffsetMinutes) || Math.abs(utcOffsetMinutes) > 840)) {
      return fail(c, 400, 'VALIDATION_ERROR', 'utcOffsetMinutes must be between -840 and 840.');
    }
    let cleanMapping: Partial<Record<CanonicalField, string>> | undefined;
    if (mapping != null) {
      if (typeof mapping !== 'object' || Array.isArray(mapping)) return fail(c, 400, 'VALIDATION_ERROR', 'mapping must be an object.');
      cleanMapping = {};
      for (const [k, v] of Object.entries(mapping)) {
        if (!CANONICAL.includes(k as CanonicalField) || typeof v !== 'string' || v.length > 100) return fail(c, 400, 'VALIDATION_ERROR', `Invalid mapping entry "${k}".`);
        cleanMapping[k as CanonicalField] = v;
      }
    }

    const userId = c.get('userId');
    const res = parseImport({ source: source as SourceId | 'auto', fileName, contentBase64, utcOffsetMinutes: utcOffsetMinutes as number | undefined, mapping: cleanMapping });
    const { fileHash, ...out } = res;

    if (res.trades.length > 0) {
      const now = deps.now();
      const claim = await deps.store.get(userId, `IMPORT#${fileHash}`);
      const claimed = claim && typeof claim.expiresAt === 'string' && Date.parse(claim.expiresAt) > now.getTime();
      if (!claimed) {
        const q = await c.get('quota').consume('broker_import');
        if (!q.ok) return quotaFail(c, 'broker_import', q);
        await deps.store.put({
          userId,
          sk: `IMPORT#${fileHash}`,
          entity: 'import-claim',
          expiresAt: new Date(now.getTime() + REPARSE_WINDOW_MS).toISOString(),
          ttl: Math.floor(now.getTime() / 1000) + 3600,
        });
      }
    }

    let duplicates: number | undefined;
    if (typeof accountId === 'string' && res.trades.length) {
      try {
        const keys = await deps.trades.importedKeys(userId, accountId, importKeyPrefix(accountId));
        duplicates = 0;
        for (const t of res.trades) {
          if (keys.has(importKey(accountId, t))) {
            t.duplicate = true;
            duplicates++;
          }
        }
        if (duplicates) out.warnings.push(`${duplicates} trades in this file were already imported into this account.`);
      } catch {
        out.warnings.push('Could not check for trades that were already imported; duplicates are still skipped when saving.');
      }
    }
    return ok(c, { ...out, ...(duplicates != null ? { duplicates } : {}) });
  });

  return app;
}
