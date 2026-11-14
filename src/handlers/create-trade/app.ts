import type { ApiHandler } from '../../shared/types';
import { ddb } from '../../shared/dynamo';
import { PutCommand, BatchWriteCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { v4 as uuid } from 'uuid';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { normalizePotentialKey } from '../../shared/s3';
import { presentTrade } from '../../shared/presentTrade';
import { tradeCreateSchema } from '../../schemas';
import { getValidator, formatErrors, envelope, errorResponse, ErrorCodes, errorFromException } from '../../shared/validation';
import { makeLogger } from '../../shared/logger';
import { getUserId } from '../../shared/auth';
import { tagsError } from '../../shared/tags';
import { contractFields } from '../../shared/tradeFields';
import { calcPnL } from '../../shared/utils/pnl';
import { adoptUploads, copyImagesToTrade, ownsImageKey } from '../../shared/images';

const TRADES_TABLE = process.env.TRADES_TABLE!;
const IMAGES_BUCKET = process.env.IMAGES_BUCKET!;
const s3 = new S3Client({});

const ALLOWED_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
const MAX_IMAGES_PER_TRADE = 6;

/** Shared risk/reward calculation for both bulk and single paths */
function calculateRiskReward(t: { riskRewardRatio?: any; entryPrice?: any; exitPrice?: any; stopLoss?: any }): number | null {
  const num = (v: any) => (v === undefined || v === null || v === '' ? null : Number(v));
  const rr = num(t.riskRewardRatio);
  if (rr != null) return rr;
  const entry = num(t.entryPrice);
  const exit = num(t.exitPrice);
  if (entry != null && exit != null) {
    const sl = num(t.stopLoss);
    if (sl != null && sl !== entry) {
      const risk = Math.abs(entry - sl);
      const reward = Math.abs(exit - entry);
      return risk > 0 ? Number((reward / risk).toFixed(4)) : 0;
    }
    return 0;
  }
  return null;
}

const num = (v: any) => (v === undefined || v === null || v === '' ? null : Number(v));

/** The stored item of one account. P&L is the client's value, else the shared formula (undefined side or prices leave it null). */
function buildItem(userId: string, t: any, o: { tradeId: string; accountId: string; images: any[]; now: string; idempotencyKey?: string }): any {
  const entryPrice = num(t.entryPrice);
  const exitPrice = num(t.exitPrice);
  const quantity = Number(t.quantity);
  const pnl = num(t.pnl) ?? (Number.isNaN(quantity) ? undefined : calcPnL({ side: t.side, entryPrice, exitPrice, quantity, contractMultiplier: t.contractMultiplier })) ?? null;
  const item: any = {
    userId,
    tradeId: o.tradeId,
    accountId: o.accountId || '-1',
    symbol: t.symbol,
    side: t.side,
    quantity,
    openDate: t.openDate,
    closeDate: t.closeDate || null,
    entryPrice,
    exitPrice,
    stopLoss: num(t.stopLoss),
    takeProfit: num(t.takeProfit),
    pnl,
    riskRewardRatio: calculateRiskReward(t),
    setupType: t.setupType || null,
    marketCondition: t.marketCondition || null,
    tradingSession: t.tradingSession || null,
    tradeNotes: t.tradeNotes || null,
    mistakes: Array.isArray(t.mistakes) ? t.mistakes : [],
    lessons: Array.isArray(t.lessons) ? t.lessons : [],
    newsEvents: Array.isArray(t.newsEvents) ? t.newsEvents : [],
    outcome: t.outcome,
    tags: Array.isArray(t.tags) ? t.tags : [],
    brokenRuleIds: Array.isArray(t.brokenRuleIds) ? t.brokenRuleIds : [],
    reviewed: t.reviewed === true,
    ...contractFields(t),
    images: o.images,
    createdAt: o.now,
    updatedAt: o.now,
  };
  if (o.idempotencyKey) item.idempotencyKey = `${o.idempotencyKey}-${item.accountId}`;
  return item;
}

/** `accountIds`, else the singular `accountId`, else unassigned; each account once. */
function requestedAccounts(t: any): string[] {
  const ids: string[] = Array.isArray(t.accountIds) && t.accountIds.length > 0 ? t.accountIds : t.accountId ? [t.accountId] : ['-1'];
  return [...new Set(ids)];
}

/** Looks up the trade stored under `<key>-<accountId>`; a failed lookup throws, so a retry never creates a duplicate. */
async function findByIdempotencyKey(userId: string, key: string, accountId: string): Promise<any | undefined> {
  const res = await ddb.send(new QueryCommand({
    TableName: TRADES_TABLE,
    IndexName: 'user-idempotency-gsi',
    KeyConditionExpression: 'userId = :u AND idempotencyKey = :k',
    ExpressionAttributeValues: { ':u': userId, ':k': `${key}-${accountId || '-1'}` },
  }));
  return res.Items?.[0];
}

export const handler: ApiHandler = async (event) => {
  try {
  const userId = getUserId(event);
  const log = makeLogger({ requestId: event.requestContext.requestId, userId });
  log.info('create-trade invoked', { hasAuth: !!userId, isBulk: false });
  if (!userId) { log.warn('unauthorized request'); return errorResponse(401, ErrorCodes.UNAUTHORIZED, 'Unauthorized'); }

  if (!event.body) { log.warn('missing body'); return errorResponse(400, ErrorCodes.VALIDATION_ERROR, 'Missing body'); }
  let data: any;
  try { data = JSON.parse(event.body); } catch (e) { log.warn('invalid json', { error: (e as any)?.message }); return errorResponse(400, ErrorCodes.VALIDATION_ERROR, 'Invalid JSON'); }
  if (!data || typeof data !== 'object' || Array.isArray(data)) return errorResponse(400, ErrorCodes.VALIDATION_ERROR, 'Body must be a JSON object');
  log.debug('parsed body', { keys: Object.keys(data) });

    // Validate single create payload (bulk handled separately below)
  if (!Array.isArray(data.items)) {
      if (Array.isArray(data.images) && data.images.length > MAX_IMAGES_PER_TRADE) return errorResponse(400, ErrorCodes.VALIDATION_ERROR, `A trade can have at most ${MAX_IMAGES_PER_TRADE} images`);
      const validate = getValidator(tradeCreateSchema, 'tradeCreate');
      const valid = validate(data);
      if (!valid) {
    const details = formatErrors(validate.errors);
    log.warn('single create validation failed', { details });
    return errorResponse(400, ErrorCodes.VALIDATION_ERROR, 'Invalid request body', details);
      }
    }

    // Bulk import path: if body has items[] treat as bulk create
    if (Array.isArray(data.items)) {
      const itemsArr = data.items;
      const MAX_BULK = 50;
      log.info('bulk create detected', { count: itemsArr.length });
      if (itemsArr.length === 0) { log.warn('bulk empty'); return errorResponse(400, ErrorCodes.VALIDATION_ERROR, 'items array empty'); }
      if (itemsArr.length > MAX_BULK) { log.warn('bulk over limit', { count: itemsArr.length }); return errorResponse(400, ErrorCodes.VALIDATION_ERROR, `Too many items (max ${MAX_BULK})`); }

      const created: any[] = []; const skipped: any[] = []; const errors: any[] = [];
      // Helper to process single trade definition
  const processOne = async (raw: any, index: number) => {
        try {
          if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Each item must be an object');
          // The idempotency key is not part of the trade schema; validate the rest like the single path does.
          const { idempotencyKey, idemKey, ...t } = raw;
          const validateItem = getValidator(tradeCreateSchema, 'tradeCreate');
          if (!validateItem(t)) throw new Error(formatErrors(validateItem.errors)[0]?.message ?? 'Invalid item');
          if (t.tags !== undefined) { const tagProblem = tagsError(t.tags); if (tagProblem) throw new Error(tagProblem); }
          const tradeIdLocal = uuid();
            const idemKeyItem = idempotencyKey || idemKey || null;
            const requestedIds = requestedAccounts(t);
            let accountsToCreate = requestedIds;
            if (idemKeyItem) {
              // Stored form is `<key>-<accountId>`; skip the accounts that already hold this trade.
              const missing: string[] = [];
              for (const accountId of requestedIds) {
                const existingItem = await findByIdempotencyKey(userId, idemKeyItem, accountId);
                if (existingItem) skipped.push({ index, tradeId: existingItem.tradeId, accountId, reason: 'idempotent_duplicate' });
                else missing.push(accountId);
              }
              if (missing.length === 0) { log.info('bulk idempotent skip', { index }); return null; }
              accountsToCreate = missing;
            }
          // Process images for this trade
          const imagesInput: any[] = Array.isArray(t.images) ? t.images : [];
          if (imagesInput.length > MAX_IMAGES_PER_TRADE) throw new Error(`A trade can have at most ${MAX_IMAGES_PER_TRADE} images`);
          const images: any[] = [];
          const MAX_IMAGE_BYTES = 5 * 1024 * 1024; // 5MB decoded size limit
          const bulkUploadTasks: Array<{ imgId: string; key: string; buffer: Buffer; contentType: string; timeframe: string | null; description: string | null }> = [];
          for (const img of imagesInput) {
            const imgId = img.id || uuid();
            const isDataUriUrl = typeof img.url === 'string' && /^data:image\//i.test(img.url);
            const inline = img.base64Data || (isDataUriUrl ? img.url : null);
            if (inline) {
              let b64 = inline as string;
              const match = /^data:(.+);base64,(.*)$/i.exec(b64);
              let contentType = 'image/jpeg';
              if (match) { contentType = match[1]; b64 = match[2]; }
              if (!ALLOWED_IMAGE_TYPES.includes(contentType)) {
                throw new Error(`Unsupported image type: ${contentType}`);
              }
              const buffer = Buffer.from(b64, 'base64');
              if (buffer.byteLength > MAX_IMAGE_BYTES) {
                throw new Error('Inline image exceeds 5MB limit');
              }
              const ext = contentType === 'image/png' ? '.png' : contentType === 'image/gif' ? '.gif' : contentType === 'image/webp' ? '.webp' : '.jpg';
              const key = `images/${userId}/${tradeIdLocal}/${imgId}${ext}`;
              bulkUploadTasks.push({ imgId, key, buffer, contentType, timeframe: img.timeframe || null, description: img.description || null });
            } else if (img.key || img.url) {
              // A key from POST /uploads/images (or an internal import). Arbitrary external URLs are ignored on the bulk path.
              const uploaded = typeof img.key === 'string' ? img.key : img.url;
              if (ownsImageKey(userId, uploaded)) {
                images.push({ id: imgId, key: uploaded, timeframe: img.timeframe || null, description: img.description || null });
              }
            }
          }
          // Upload all inline images to S3 in parallel
          if (bulkUploadTasks.length > 0) {
            await Promise.all(bulkUploadTasks.map(task =>
              s3.send(new PutObjectCommand({ Bucket: IMAGES_BUCKET, Key: task.key, Body: task.buffer, ContentType: task.contentType }))
            ));
            for (const task of bulkUploadTasks) {
              images.push({ id: task.imgId, key: task.key, timeframe: task.timeframe, description: task.description });
            }
          }
          const nowLocal = new Date().toISOString();
          // The first account's trade owns the uploaded screenshots (images/<user>/<tradeId>/); the others get copies.
          const ownImages = await adoptUploads(userId, images, tradeIdLocal);
          const itemsToCreate: any[] = [];
          for (const [i, accountId] of accountsToCreate.entries()) {
            const tradeId = i === 0 ? tradeIdLocal : uuid();
            const itemImages = i === 0 ? ownImages : await copyImagesToTrade(userId, ownImages, tradeId);
            itemsToCreate.push(buildItem(userId, t, { tradeId, accountId, images: itemImages, now: nowLocal, idempotencyKey: idemKeyItem || undefined }));
          }

          log.debug('bulk item prepared', { index, tradeId: tradeIdLocal, accountCount: itemsToCreate.length });
          return itemsToCreate;
        } catch (err: any) {
          errors.push({ index, message: err.message || 'error' });
          log.warn('bulk item error', { index, error: err.message });
          return null;
        }
      };

      // Process in parallel batches of 10 for throughput
      const PARALLEL_BATCH = 10;
      const toWrite: any[] = [];

      for (let batch = 0; batch < itemsArr.length; batch += PARALLEL_BATCH) {
        const batchSlice = itemsArr.slice(batch, batch + PARALLEL_BATCH);
        const results = await Promise.allSettled(
          batchSlice.map((item: any, idx: number) => processOne(item, batch + idx))
        );

        for (const result of results) {
          if (result.status === 'fulfilled' && result.value) {
            if (Array.isArray(result.value)) {
              toWrite.push(...result.value);
            } else {
              toWrite.push(result.value);
            }
          }
          // Rejected results are already handled inside processOne (pushed to errors array)
        }
      }

      // Batch write in chunks of 25; `created` lists only what reached the table.
      const CHUNK = 25;
      for (let i = 0; i < toWrite.length; i += CHUNK) {
        const slice = toWrite.slice(i, i + CHUNK);
        let attempts = 0;
        let unprocessed = slice;
        let reason = 'Unprocessed after retries';
        try {
          while (unprocessed.length && attempts < 3) {
            const respBW = await ddb.send(new BatchWriteCommand({
              RequestItems: {
                [TRADES_TABLE]: unprocessed.map(it => ({ PutRequest: { Item: it } }))
              }
            }));
            const up = respBW.UnprocessedItems?.[TRADES_TABLE];
            if (up && up.length) {
              unprocessed = up.map(r => (r as any).PutRequest.Item);
              attempts++;
              log.warn('batch write unprocessed retrying', { attempt: attempts, remaining: unprocessed.length });
              await new Promise(r => setTimeout(r, 50 * attempts));
            } else {
              unprocessed = [];
            }
          }
        } catch (err: any) {
          log.error('bulk batch write failed', { error: err?.message });
          reason = 'Write failed';
        }
        const notSaved = new Set(unprocessed.map(it => it.tradeId));
        created.push(...slice.filter(it => !notSaved.has(it.tradeId)));
        for (const it of unprocessed) errors.push({ tradeId: it.tradeId, message: reason });
      }
      log.info('bulk create complete', { created: created.length, skipped: skipped.length, errors: errors.length });
      return envelope({ statusCode: 201, data: { created: created.length, skipped, errors, items: created.map(presentTrade) } });
    }

    // Single create path
    const idemKey: string | undefined = event.headers?.['idempotency-key'];
    const tradeId = uuid();
    const accountIds = requestedAccounts(data);
    // An account that already holds this trade (stored as `<key>-<accountId>`) is not created again.
    const existingItems: any[] = [];
    let toCreate = accountIds;
    if (idemKey) {
      toCreate = [];
      for (const accountId of accountIds) {
        const found = await findByIdempotencyKey(userId, idemKey, accountId);
        if (found) existingItems.push(found); else toCreate.push(accountId);
      }
      if (toCreate.length === 0) {
        log.info('single create idempotent repeat', { tradeId: existingItems[0].tradeId });
        const shown = existingItems.map(presentTrade);
        return envelope({ statusCode: 200, data: shown.length === 1 ? { trade: shown[0] } : { trades: shown, count: shown.length }, message: 'Trade already created' });
      }
    }

    // Process images (optional). Each image may have: id, base64Data, timeframe, description.
          const imagesInput: any[] = Array.isArray(data.images) ? data.images : [];
    const images: any[] = [];
    const MAX_IMAGE_BYTES = 5 * 1024 * 1024; // 5MB decoded size limit

    // Prepare all images: validate sizes and build upload tasks before any S3 calls
    const uploadTasks: Array<{ imgId: string; key: string; buffer: Buffer; contentType: string; timeframe: string | null; description: string | null }> = [];
  for (const img of imagesInput) {
      const imgId = img.id || uuid();
      const isDataUriUrl = typeof img.url === 'string' && /^data:image\//i.test(img.url);
      const inline = img.base64Data || (isDataUriUrl ? img.url : null);
      if (inline) {
        let b64 = inline as string;
        const match = /^data:(.+);base64,(.*)$/i.exec(b64);
        let contentType = 'image/jpeg';
        if (match) { contentType = match[1]; b64 = match[2]; }
        if (!ALLOWED_IMAGE_TYPES.includes(contentType)) {
          return errorResponse(400, ErrorCodes.VALIDATION_ERROR, `Unsupported image type: ${contentType}`);
        }
        const buffer = Buffer.from(b64, 'base64');
        if (buffer.byteLength > MAX_IMAGE_BYTES) {
          return errorResponse(400, ErrorCodes.VALIDATION_ERROR, 'Inline image exceeds 5MB limit');
        }
        const ext = contentType === 'image/png' ? '.png' : contentType === 'image/gif' ? '.gif' : contentType === 'image/webp' ? '.webp' : '.jpg';
        const key = `images/${userId}/${tradeId}/${imgId}${ext}`;
        uploadTasks.push({ imgId, key, buffer, contentType, timeframe: img.timeframe || null, description: img.description || null });
      } else if (img.key || img.url) {
        const keyCandidate = typeof img.key === 'string' ? img.key : normalizePotentialKey(img.url, IMAGES_BUCKET);
        if (keyCandidate && ownsImageKey(userId, keyCandidate)) {
          images.push({ id: imgId, key: keyCandidate, timeframe: img.timeframe || null, description: img.description || null });
        }
      }
    }

    // Upload all inline images to S3 in parallel
    if (uploadTasks.length > 0) {
      await Promise.all(uploadTasks.map(task =>
        s3.send(new PutObjectCommand({ Bucket: IMAGES_BUCKET, Key: task.key, Body: task.buffer, ContentType: task.contentType }))
      ));
      for (const task of uploadTasks) {
        images.push({ id: task.imgId, key: task.key, timeframe: task.timeframe, description: task.description });
      }
    }

    const now = new Date().toISOString();
    // The first created account's trade owns the uploaded screenshots (images/<user>/<tradeId>/); the others get copies.
    const storedImages = (await adoptUploads(userId, images, tradeId)).map(im => ({ id: im.id, key: im.key, timeframe: im.timeframe ?? null, description: im.description ?? null }));
    const itemsToCreate: any[] = [];
    for (const [i, accountId] of toCreate.entries()) {
      const itemTradeId = i === 0 ? tradeId : uuid();
      const itemImages = i === 0 ? storedImages : await copyImagesToTrade(userId, storedImages, itemTradeId);
      itemsToCreate.push(buildItem(userId, data, { tradeId: itemTradeId, accountId, images: itemImages, now, idempotencyKey: idemKey }));
    }

    // Write all items (one per account)
    await Promise.all(itemsToCreate.map((item: any) =>
      ddb.send(new PutCommand({ TableName: TRADES_TABLE, Item: item }))
    ));

    log.info('single trade(s) created', { count: itemsToCreate.length, tradeIds: itemsToCreate.map((i: any) => i.tradeId) });

    // Return the one trade, or every account's trade (those an earlier attempt created included)
    const all = [...existingItems, ...itemsToCreate].map(presentTrade);
    const responseData = all.length === 1 ? { trade: all[0] } : { trades: all, count: all.length };

    return envelope({ statusCode: 201, data: responseData, message: 'Trade created successfully' });
  } catch (err: any) {
    console.error(err);
    return errorFromException(err, true);
  }
};
// Legacy resp removed in favor of envelope/errorResponse
