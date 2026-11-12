import type { ApiHandler } from '../../shared/types';
import { ddb } from '../../shared/dynamo';
import { PutCommand, BatchWriteCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { v4 as uuid } from 'uuid';
import { S3Client, PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { normalizePotentialKey } from '../../shared/s3';
import { tradeCreateSchema } from '../../schemas';
import { getValidator, formatErrors, envelope, errorResponse, ErrorCodes, errorFromException } from '../../shared/validation';
import { makeLogger } from '../../shared/logger';
import { getUserId } from '../../shared/auth';
import { checkSubscription } from '../../shared/subscription';
import { tagsError } from '../../shared/tags';

const TRADES_TABLE = process.env.TRADES_TABLE!;
const IMAGES_BUCKET = process.env.IMAGES_BUCKET!;
const s3 = new S3Client({});

const ALLOWED_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
const MAX_IMAGES_PER_TRADE = 6;

/** CONTRACT §6 optional fields (plus importBatchId); only fields present in the request are stored. */
function contractFields(t: any): Record<string, any> {
  const out: Record<string, any> = {};
  const numeric = ['fees', 'grossPnl', 'contractMultiplier', 'strike'];
  const text = ['assetClass', 'underlying', 'optionType', 'expiry', 'externalId', 'importSource', 'importBatchId'];
  for (const f of numeric) if (t[f] !== undefined && t[f] !== null && t[f] !== '') out[f] = Number(t[f]);
  for (const f of text) if (typeof t[f] === 'string' && t[f] !== '') out[f] = t[f];
  return out;
}

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

export const handler: ApiHandler = async (event) => {
  try {
  const userId = getUserId(event);
  const log = makeLogger({ requestId: event.requestContext.requestId, userId });
  log.info('create-trade invoked', { hasAuth: !!userId, isBulk: false });
  if (!userId) { log.warn('unauthorized request'); return errorResponse(401, ErrorCodes.UNAUTHORIZED, 'Unauthorized'); }

  const subError = await checkSubscription(userId);
  if (subError) return subError;

  if (!event.body) { log.warn('missing body'); return errorResponse(400, ErrorCodes.VALIDATION_ERROR, 'Missing body'); }
  let data: any;
  try { data = JSON.parse(event.body); } catch (e) { log.warn('invalid json', { error: (e as any)?.message }); return errorResponse(400, ErrorCodes.VALIDATION_ERROR, 'Invalid JSON'); }
  if (!data || typeof data !== 'object' || Array.isArray(data)) return errorResponse(400, ErrorCodes.VALIDATION_ERROR, 'Body must be a JSON object');
  log.debug('parsed body', { keys: Object.keys(data) });

    // Validate single create payload (bulk handled separately below)
  if (!Array.isArray(data.items)) {
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
  const processOne = async (t: any, index: number) => {
        try {
          const requiredFields = ['symbol','side','quantity','openDate'];
      for (const f of requiredFields) if (t[f] === undefined || t[f] === null || t[f] === '') { log.debug('bulk item missing field', { index, field: f }); throw new Error(`Missing field ${f}`); }
          if (t.tags !== undefined) { const tagProblem = tagsError(t.tags); if (tagProblem) throw new Error(tagProblem); }
          const tradeIdLocal = uuid();
            const idemKeyItem = t.idempotencyKey || t.idemKey || null;
            const requestedAccounts: string[] = Array.isArray(t.accountIds) && t.accountIds.length > 0 ? t.accountIds : ['-1'];
            let accountsToCreate = requestedAccounts;
            if (idemKeyItem) {
              // Stored form is `<key>-<accountId>`; skip the accounts that already hold this trade.
              const missing: string[] = [];
              for (const accountId of requestedAccounts) {
                let existingItem: any;
                try {
                  const existing = await ddb.send(new QueryCommand({
                    TableName: TRADES_TABLE,
                    IndexName: 'user-idempotency-gsi',
                    KeyConditionExpression: 'userId = :u AND idempotencyKey = :k',
                    ExpressionAttributeValues: { ':u': userId, ':k': `${idemKeyItem}-${accountId || '-1'}` },
                  }));
                  existingItem = existing.Items?.[0];
                } catch (e) { log.warn('bulk idempotency lookup failed', { index, error: (e as any)?.message }); }
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
              if (uploaded.startsWith(`images/${userId}/`)) {
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
          const num = (v: any) => (v === undefined || v === null || v === '' ? null : Number(v));
          const entryPrice = num(t.entryPrice);
          const exitPrice = num(t.exitPrice);
          const quantity = Number(t.quantity);
          
          // Use PnL from frontend if provided (already calculated in UI)
          let pnl = num(t.pnl);
          if (pnl == null && entryPrice != null && exitPrice != null && !Number.isNaN(quantity)) {
            if (t.side === 'BUY') pnl = (exitPrice - entryPrice) * quantity; 
            else if (t.side === 'SELL') pnl = (entryPrice - exitPrice) * quantity;
          }
          
          // Use riskRewardRatio from frontend if provided, otherwise calculate from SL
          const riskRewardRatio = calculateRiskReward(t);
          const outcome = t.outcome;
          const nowLocal = new Date().toISOString();
          
          const accountIds = accountsToCreate;
          
          const itemsToCreate = accountIds.map((accountId: string) => {
            const tradeId = accountIds.length > 1 ? uuid() : tradeIdLocal; // Unique ID per account if multiple
            const item: any = {
              userId,
              tradeId,
              accountId: accountId || '-1',
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
              riskRewardRatio,
              setupType: t.setupType || null,
              marketCondition: t.marketCondition || null,
              tradingSession: t.tradingSession || null,
              tradeNotes: t.tradeNotes || null,
              mistakes: Array.isArray(t.mistakes) ? t.mistakes : [],
              lessons: Array.isArray(t.lessons) ? t.lessons : [],
              newsEvents: Array.isArray(t.newsEvents) ? t.newsEvents : [],
              outcome,
              tags: Array.isArray(t.tags) ? t.tags : [],
              images,
              brokenRuleIds: Array.isArray(t.brokenRuleIds) ? t.brokenRuleIds : [],
              ...contractFields(t),
              createdAt: nowLocal,
              updatedAt: nowLocal,
            };
            if (idemKeyItem) item.idempotencyKey = `${idemKeyItem}-${accountId || '-1'}`;
            return item;
          });
          
          created.push(...itemsToCreate);
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

      // Batch write in chunks of 25
      const CHUNK = 25;
      for (let i=0;i<toWrite.length;i+=CHUNK) {
        let slice = toWrite.slice(i, i+CHUNK);
        let attempts = 0;
        let unprocessed = slice;
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
        if (unprocessed.length) {
          // Mark remaining as errors
          for (const it of unprocessed) {
            errors.push({ tradeId: it.tradeId, message: 'Unprocessed after retries' });
          }
        }
      }
    log.info('bulk create complete', { created: created.length, skipped: skipped.length, errors: errors.length });
  return envelope({ statusCode: 201, data: { created: created.length, skipped, errors, items: created } });
    }

    // Single create path
    const required = ['symbol', 'side', 'quantity', 'openDate'];
  for (const f of required) if (data[f] === undefined || data[f] === null || data[f] === '') { log.warn('single create missing field', { field: f }); return errorResponse(400, ErrorCodes.VALIDATION_ERROR, `Missing field ${f}`); }
    const idemKey = event.headers?.['Idempotency-Key'] || event.headers?.['idempotency-key'];
    let tradeId = uuid();
    const accountIds: string[] = Array.isArray(data.accountIds) && data.accountIds.length > 0 ? data.accountIds : ['-1'];
    if (idemKey) {
      try {
        // Stored form is `<key>-<accountId>`; a repeat is recognised by the first account's record.
        const existing = await ddb.send(new QueryCommand({
          TableName: TRADES_TABLE,
          IndexName: 'user-idempotency-gsi',
          KeyConditionExpression: 'userId = :u AND idempotencyKey = :k',
          ExpressionAttributeValues: { ':u': userId, ':k': `${idemKey}-${accountIds[0] || '-1'}` }
        }));
        if (existing.Items && existing.Items[0]) {
          log.info('single create idempotent repeat', { tradeId: existing.Items[0].tradeId });
          const existingItem: any = existing.Items[0];
          if (Array.isArray(existingItem.images)) {
            existingItem.images = existingItem.images.map((im: any) => {
              const keyCandidate = im.key || normalizePotentialKey(im.url, IMAGES_BUCKET);
              if (keyCandidate) {
                // Return image ID instead of signed URL
                return { ...im, id: keyCandidate, key: keyCandidate };
              }
              return { ...im, id: im.id || im.key || '' };
            });
          }
          return envelope({ statusCode: 200, data: { trade: existingItem }, message: 'Trade already created' });
        }
      } catch (e) { log.warn('idempotency lookup failed', { error: (e as any)?.message }); }
    }

    // Helper to sanitize number or null
    const num = (v: any) => (v === undefined || v === null || v === '' ? null : Number(v));

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
        if (keyCandidate && keyCandidate.startsWith(`images/${userId}/`)) {
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

    // Derived calculations
  const entryPrice = num(data.entryPrice);
  const exitPrice = num(data.exitPrice);
  const quantity = Number(data.quantity);
  
  // Use PnL from frontend if provided (already calculated in UI)
  let pnl = num(data.pnl);
  if (pnl == null && entryPrice != null && exitPrice != null && !Number.isNaN(quantity)) {
    if (data.side === 'BUY') pnl = (exitPrice - entryPrice) * quantity; 
    else if (data.side === 'SELL') pnl = (entryPrice - exitPrice) * quantity;
  }
  
  // Use riskRewardRatio from frontend if provided, otherwise calculate from SL
  const riskRewardRatio = calculateRiskReward(data);
  const outcome = data.outcome;

    const now = new Date().toISOString();
    
    // One entry per account (accountIds defaults to ['-1'], computed above).
    
    const itemsToCreate = accountIds.map((accountId: string) => {
      const itemTradeId = accountIds.length > 1 ? uuid() : tradeId; // Unique ID per account if multiple
      const item: any = {
        userId,
        tradeId: itemTradeId,
        accountId: accountId || '-1',
        symbol: data.symbol,
        side: data.side,
        quantity,
        openDate: data.openDate,
        closeDate: data.closeDate || null,
        entryPrice,
        exitPrice,
        stopLoss: num(data.stopLoss),
        takeProfit: num(data.takeProfit),
        pnl,
        riskRewardRatio,
        setupType: data.setupType || null,
        marketCondition: data.marketCondition || null,
        tradingSession: data.tradingSession || null,
        tradeNotes: data.tradeNotes || null,
        mistakes: Array.isArray(data.mistakes) ? data.mistakes : [],
        lessons: Array.isArray(data.lessons) ? data.lessons : [],
        newsEvents: Array.isArray(data.newsEvents) ? data.newsEvents : [],
        outcome,
        tags: Array.isArray(data.tags) ? data.tags : [],
        brokenRuleIds: Array.isArray(data.brokenRuleIds) ? data.brokenRuleIds : [],
        ...contractFields(data),
        images: images.map(im => ({ id: im.id, key: im.key, timeframe: im.timeframe ?? null, description: im.description ?? null })),
        createdAt: now,
        updatedAt: now,
      };
      if (idemKey) item.idempotencyKey = `${idemKey}-${accountId || '-1'}`;
      return item;
    });

  // Write all items (one per account)
  await Promise.all(itemsToCreate.map((item: any) => 
    ddb.send(new PutCommand({ TableName: TRADES_TABLE, Item: item }))
  ));
  
  log.info('single trade(s) created', { count: itemsToCreate.length, tradeIds: itemsToCreate.map((i: any) => i.tradeId) });
  
  // Attach image IDs for response only
  const itemsWithImageIds = itemsToCreate.map((item: any) => {
    const imagesWithIds = item.images.map((im: any) => {
      if (im.key) {
        // Return image ID instead of signed URL
        return { ...im, id: im.key };
      }
      return { ...im, id: im.id || im.key || '' };
    });
    return { ...item, images: imagesWithIds };
  });
  
  // Return first item for single account, or all items for multiple accounts
  const responseData = itemsToCreate.length === 1 
    ? { trade: itemsWithImageIds[0] } 
    : { trades: itemsWithImageIds, count: itemsWithImageIds.length };
  
  return envelope({ statusCode: 201, data: responseData, message: 'Trade created successfully' });
  } catch (err: any) {
    console.error(err);
    return errorFromException(err, true);
  }
};
// Legacy resp removed in favor of envelope/errorResponse
