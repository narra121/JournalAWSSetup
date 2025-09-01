import { APIGatewayProxyHandlerV2 } from 'aws-lambda';
import { ddb } from '../../shared/dynamo';
import { PutCommand, BatchWriteCommand } from '@aws-sdk/lib-dynamodb';
import { v4 as uuid } from 'uuid';
import { S3Client, PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { normalizePotentialKey } from '../../shared/s3';
import { tradeCreateSchema } from '../../schemas';
import { getValidator, formatErrors, envelope, errorResponse, ErrorCodes, errorFromException } from '../../shared/validation';
import { makeLogger } from '../../shared/logger';

const TRADES_TABLE = process.env.TRADES_TABLE!;
const IMAGES_BUCKET = process.env.IMAGES_BUCKET!;
const s3 = new S3Client({});

export const handler: APIGatewayProxyHandlerV2 = async (event) => {
  try {
    const rc: any = event.requestContext as any;
    const claims = rc?.authorizer?.jwt?.claims || {};
    const userId = claims.sub;
  const log = makeLogger({ requestId: event.requestContext.requestId, userId });
  log.info('create-trade invoked', { hasAuth: !!userId, isBulk: false });
  if (!userId) { log.warn('unauthorized request'); return errorResponse(401, ErrorCodes.UNAUTHORIZED, 'Unauthorized'); }

  if (!event.body) { log.warn('missing body'); return errorResponse(400, ErrorCodes.VALIDATION_ERROR, 'Missing body'); }
  let data: any;
  try { data = JSON.parse(event.body); } catch (e) { log.warn('invalid json', { error: (e as any)?.message }); return errorResponse(400, ErrorCodes.VALIDATION_ERROR, 'Invalid JSON'); }
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
      // Lazy import for idempotency queries once
      const { QueryCommand } = await import('@aws-sdk/lib-dynamodb');

      // Helper to process single trade definition
  const processOne = async (t: any, index: number) => {
        try {
          const requiredFields = ['symbol','side','quantity','openDate'];
      for (const f of requiredFields) if (!t[f]) { log.debug('bulk item missing field', { index, field: f }); throw new Error(`Missing field ${f}`); }
          const tradeIdLocal = uuid();
            const idemKeyItem = t.idempotencyKey || t.idemKey || null;
            if (idemKeyItem) {
              try {
                const existing = await ddb.send(new QueryCommand({
                  TableName: TRADES_TABLE,
                  IndexName: 'user-idempotency-gsi',
                  KeyConditionExpression: 'userId = :u AND idempotencyKey = :k',
                  ExpressionAttributeValues: { ':u': userId, ':k': idemKeyItem }
                }));
        if (existing.Items && existing.Items[0]) { skipped.push({ index, tradeId: existing.Items[0].tradeId, reason: 'idempotent_duplicate' }); log.info('bulk idempotent skip', { index }); return null; }
      } catch (e) { log.warn('bulk idempotency lookup failed', { index, error: (e as any)?.message }); }
            }
          // Process images for this trade
          const imagesInput: any[] = Array.isArray(t.images) ? t.images : [];
          const images: any[] = [];
          const MAX_IMAGE_BYTES = 5 * 1024 * 1024; // 5MB decoded size limit
          for (const img of imagesInput) {
            const imgId = img.id || uuid();
            const isDataUriUrl = typeof img.url === 'string' && /^data:image\//i.test(img.url);
            const inline = img.base64Data || (isDataUriUrl ? img.url : null);
            if (inline) {
              let b64 = inline as string;
              const match = /^data:(.+);base64,(.*)$/i.exec(b64);
              let contentType = 'image/jpeg';
              if (match) { contentType = match[1]; b64 = match[2]; }
              const buffer = Buffer.from(b64, 'base64');
              if (buffer.byteLength > MAX_IMAGE_BYTES) {
                throw new Error('Inline image exceeds 5MB limit');
              }
              const ext = contentType === 'image/png' ? '.png' : contentType === 'image/gif' ? '.gif' : '.jpg';
              const key = `images/${userId}/${tradeIdLocal}/${imgId}${ext}`;
              await s3.send(new PutObjectCommand({ Bucket: IMAGES_BUCKET, Key: key, Body: buffer, ContentType: contentType }));
              images.push({ id: imgId, key, timeframe: img.timeframe || null, description: img.description || null });
            } else if (img.url) {
              // Accept direct key if provided (internal import use). Ignore arbitrary external URLs for bulk path.
              if (img.url.startsWith('images/')) {
                images.push({ id: imgId, key: img.url, timeframe: img.timeframe || null, description: img.description || null });
              }
            }
          }
          const num = (v: any) => (v === undefined || v === null || v === '' ? null : Number(v));
          const entryPrice = num(t.entryPrice);
          const exitPrice = num(t.exitPrice);
          const quantity = Number(t.quantity);
          // Hybrid PnL logic: prefer provided values; if missing, derive
          const commission = num(t.commission);
          const fees = t.fees ?? 0;
          let pnl = num(t.pnl);
          let netPnl = num(t.netPnl);
          const costs = (commission || 0) + (fees || 0);
          if (pnl == null && entryPrice != null && exitPrice != null && !Number.isNaN(quantity)) {
            if (t.side === 'BUY') pnl = (exitPrice - entryPrice) * quantity; else if (t.side === 'SELL') pnl = (entryPrice - exitPrice) * quantity;
          }
          if (pnl != null && netPnl == null) {
            netPnl = pnl - costs;
          } else if (pnl == null && netPnl != null) {
            pnl = netPnl + costs; // reconstruct gross
          }
          const riskAmount = num(t.riskAmount) || 0;
          const riskRewardRatio = pnl != null && riskAmount > 0 ? Number((pnl / riskAmount).toFixed(4)) : null;
          const status = t.status; // use client-provided status only
          const nowLocal = new Date().toISOString();
            const item: any = {
            userId,
            tradeId: tradeIdLocal,
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
            commission,
            fees,
            netPnl,
            riskAmount,
            riskRewardRatio,
            setupType: t.setupType || null,
            timeframe: t.timeframe || null,
            marketCondition: t.marketCondition || null,
            tradingSession: t.tradingSession || null,
            tradeGrade: t.tradeGrade || null,
            confidence: num(t.confidence),
            setupQuality: num(t.setupQuality),
            execution: num(t.execution),
            emotionalState: t.emotionalState || null,
            psychology: t.psychology || { greed: false, fear: false, fomo: false, revenge: false, overconfidence: false, patience: false },
            preTradeNotes: t.preTradeNotes || null,
            postTradeNotes: t.postTradeNotes || null,
            mistakes: Array.isArray(t.mistakes) ? t.mistakes : [],
            lessons: Array.isArray(t.lessons) ? t.lessons : [],
            newsEvents: Array.isArray(t.newsEvents) ? t.newsEvents : [],
            economicEvents: Array.isArray(t.economicEvents) ? t.economicEvents : [],
            status,
            tags: Array.isArray(t.tags) ? t.tags : [],
            images,
            createdAt: nowLocal,
            updatedAt: nowLocal,
            symbolOpenDate: `${t.symbol}#${t.openDate}`,
            statusOpenDate: `${status}#${t.openDate}`,
            // Only include idempotencyKey if provided; null would break GSI key expectations
          };
          if (idemKeyItem) item.idempotencyKey = idemKeyItem;
          created.push(item);
          log.debug('bulk item prepared', { index, tradeId: tradeIdLocal });
          return item;
        } catch (err: any) {
          errors.push({ index, message: err.message || 'error' });
          log.warn('bulk item error', { index, error: err.message });
          return null;
        }
      };

      // Process sequentially to limit parallel S3 pressure (could be parallelized with Promise.allSettled if needed)
      const toWrite: any[] = [];
  for (let i=0;i<itemsArr.length;i++) {
        const resItem = await processOne(itemsArr[i], i);
        if (resItem) toWrite.push(resItem);
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
  for (const f of required) if (!data[f]) { log.warn('single create missing field', { field: f }); return errorResponse(400, ErrorCodes.VALIDATION_ERROR, `Missing field ${f}`); }
    const idemKey = event.headers?.['Idempotency-Key'] || event.headers?.['idempotency-key'];
    let tradeId = uuid();
    if (idemKey) {
      try {
        const { QueryCommand } = await import('@aws-sdk/lib-dynamodb');
        const existing = await ddb.send(new QueryCommand({
          TableName: TRADES_TABLE,
          IndexName: 'user-idempotency-gsi',
          KeyConditionExpression: 'userId = :u AND idempotencyKey = :k',
          ExpressionAttributeValues: { ':u': userId, ':k': idemKey }
        }));
        if (existing.Items && existing.Items[0]) {
          log.info('single create idempotent repeat', { tradeId: existing.Items[0].tradeId });
          const existingItem: any = existing.Items[0];
          if (Array.isArray(existingItem.images)) {
            existingItem.images = await Promise.all(existingItem.images.map(async (im: any) => {
              const keyCandidate = im.key || normalizePotentialKey(im.url, IMAGES_BUCKET);
              if (keyCandidate) {
                const url = await getSignedUrl(s3, new GetObjectCommand({ Bucket: IMAGES_BUCKET, Key: keyCandidate }), { expiresIn: 900 });
                return { ...im, key: keyCandidate, url };
              }
              return im;
            }));
          }
          return envelope({ statusCode: 200, data: existingItem });
        }
      } catch (e) { log.warn('idempotency lookup failed', { error: (e as any)?.message }); }
    }

    // Helper to sanitize number or null
    const num = (v: any) => (v === undefined || v === null || v === '' ? null : Number(v));

    // Process images (optional). Each image may have: id, base64Data, timeframe, description.
    const imagesInput: any[] = Array.isArray(data.images) ? data.images : [];
    const images: any[] = [];
    const MAX_IMAGE_BYTES = 5 * 1024 * 1024; // 5MB decoded size limit
    for (const img of imagesInput) {
      const imgId = img.id || uuid();
      const isDataUriUrl = typeof img.url === 'string' && /^data:image\//i.test(img.url);
      const inline = img.base64Data || (isDataUriUrl ? img.url : null);
      if (inline) {
        let b64 = inline as string;
        const match = /^data:(.+);base64,(.*)$/i.exec(b64);
        let contentType = 'image/jpeg';
        if (match) { contentType = match[1]; b64 = match[2]; }
        const buffer = Buffer.from(b64, 'base64');
        if (buffer.byteLength > MAX_IMAGE_BYTES) {
          return errorResponse(400, ErrorCodes.VALIDATION_ERROR, 'Inline image exceeds 5MB limit');
        }
        const ext = contentType === 'image/png' ? '.png' : contentType === 'image/gif' ? '.gif' : '.jpg';
        const key = `images/${userId}/${tradeId}/${imgId}${ext}`;
        await s3.send(new PutObjectCommand({ Bucket: IMAGES_BUCKET, Key: key, Body: buffer, ContentType: contentType }));
        images.push({ id: imgId, key, timeframe: img.timeframe || null, description: img.description || null });
      } else if (img.url) {
        const keyCandidate = normalizePotentialKey(img.url, IMAGES_BUCKET);
        if (keyCandidate) {
          images.push({ id: imgId, key: keyCandidate, timeframe: img.timeframe || null, description: img.description || null });
        }
      }
    }

    // Derived calculations
  const entryPrice = num(data.entryPrice);
  const exitPrice = num(data.exitPrice);
  const quantity = Number(data.quantity);
  // Hybrid PnL logic for single create
  const commission = num(data.commission);
  const fees = data.fees ?? 0;
  let pnl = num(data.pnl);
  let netPnl = num(data.netPnl);
  const costs = (commission || 0) + (fees || 0);
  if (pnl == null && entryPrice != null && exitPrice != null && !Number.isNaN(quantity)) {
    if (data.side === 'BUY') pnl = (exitPrice - entryPrice) * quantity; else if (data.side === 'SELL') pnl = (entryPrice - exitPrice) * quantity;
  }
  if (pnl != null && netPnl == null) {
    netPnl = pnl - costs;
  } else if (pnl == null && netPnl != null) {
    pnl = netPnl + costs; // reconstruct gross
  }
    const riskAmount = num(data.riskAmount) || 0;
    const riskRewardRatio = pnl != null && riskAmount > 0 ? Number((pnl / riskAmount).toFixed(4)) : null;
  const status = data.status; // do not infer status; trust request

    const now = new Date().toISOString();
  const item: any = {
      userId,
      tradeId,
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
      commission,
      fees,
      netPnl,
      riskAmount,
      riskRewardRatio,
      setupType: data.setupType || null,
      timeframe: data.timeframe || null,
      marketCondition: data.marketCondition || null,
      tradingSession: data.tradingSession || null,
      tradeGrade: data.tradeGrade || null,
      confidence: num(data.confidence),
      setupQuality: num(data.setupQuality),
      execution: num(data.execution),
      emotionalState: data.emotionalState || null,
      psychology: data.psychology || {
        greed: false, fear: false, fomo: false, revenge: false, overconfidence: false, patience: false
      },
      preTradeNotes: data.preTradeNotes || null,
      postTradeNotes: data.postTradeNotes || null,
      mistakes: Array.isArray(data.mistakes) ? data.mistakes : [],
      lessons: Array.isArray(data.lessons) ? data.lessons : [],
      newsEvents: Array.isArray(data.newsEvents) ? data.newsEvents : [],
      economicEvents: Array.isArray(data.economicEvents) ? data.economicEvents : [],
      status,
      tags: Array.isArray(data.tags) ? data.tags : [],
      images,
      createdAt: now,
      updatedAt: now,
      // Composite attributes for GSIs
      symbolOpenDate: `${data.symbol}#${data.openDate}`,
      statusOpenDate: `${status}#${data.openDate}`,
      // idempotencyKey added conditionally below
    };
    if (idemKey) item.idempotencyKey = idemKey;

  await ddb.send(new PutCommand({ TableName: TRADES_TABLE, Item: item }));
  log.info('single trade created', { tradeId });
  // Attach presigned URLs for response only
  const signedImages = await Promise.all(item.images.map(async (im: any) => {
    if (im.key) {
      const url = await getSignedUrl(s3, new GetObjectCommand({ Bucket: IMAGES_BUCKET, Key: im.key }), { expiresIn: 900 });
      return { ...im, url };
    }
    return im;
  }));
  return envelope({ statusCode: 201, data: { ...item, images: signedImages } });
  } catch (err: any) {
    console.error(err);
    return errorFromException(err, true);
  }
};
// Legacy resp removed in favor of envelope/errorResponse
