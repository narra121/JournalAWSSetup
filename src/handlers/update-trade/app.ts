import type { ApiHandler } from '../../shared/types';
import { ddb } from '../../shared/dynamo';
import { GetCommand, UpdateCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import { makeLogger } from '../../shared/logger';
import { S3Client, PutObjectCommand, DeleteObjectsCommand } from '@aws-sdk/client-s3';
import { errorFromException, envelope, errorResponse, ErrorCodes, getValidator, formatErrors } from '../../shared/validation';
import { v4 as uuid } from 'uuid';
import { normalizePotentialKey } from '../../shared/s3';
import { presentTrade } from '../../shared/presentTrade';
import { getUserId } from '../../shared/auth';
import { tagsError } from '../../shared/tags';
import { tradeUpdateSchema } from '../../schemas';
import { calcPnL } from '../../shared/utils/pnl';
import { CONTRACT_FIELDS, contractFields } from '../../shared/tradeFields';
import { copyImagesToTrade } from '../../shared/images';

const TRADES_TABLE = process.env.TRADES_TABLE!;
const IMAGES_BUCKET = process.env.IMAGES_BUCKET!;
const s3 = new S3Client({});
const ALLOWED_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_IMAGES_PER_TRADE = 6;

export const handler: ApiHandler = async (event) => {
  const userId = getUserId(event);
  const requestId = event.requestContext.requestId;
  const log = makeLogger({ requestId, userId });
  try {
    if (!userId) return errorResponse(401, ErrorCodes.UNAUTHORIZED, 'Unauthorized');

    const tradeId = event.pathParameters?.tradeId;
    if (!tradeId) return errorResponse(400, ErrorCodes.VALIDATION_ERROR, 'Missing tradeId');
    if (!event.body) return errorResponse(400, ErrorCodes.VALIDATION_ERROR, 'Missing body');
    let data: any;
    try { data = JSON.parse(event.body); } catch { return errorResponse(400, ErrorCodes.VALIDATION_ERROR, 'Invalid JSON'); }
    if (!data || typeof data !== 'object' || Array.isArray(data)) return errorResponse(400, ErrorCodes.VALIDATION_ERROR, 'Body must be a JSON object');
    if (data.tags !== undefined) {
      const tagProblem = tagsError(data.tags);
      if (tagProblem) return errorResponse(400, ErrorCodes.VALIDATION_ERROR, tagProblem);
    }
    if (Array.isArray(data.images) && data.images.length > MAX_IMAGES_PER_TRADE) return errorResponse(400, ErrorCodes.VALIDATION_ERROR, `A trade can have at most ${MAX_IMAGES_PER_TRADE} images`);
    const validate = getValidator(tradeUpdateSchema, 'tradeUpdate');
    if (!validate(data)) return errorResponse(400, ErrorCodes.VALIDATION_ERROR, 'Invalid request body', formatErrors(validate.errors));

    // Fetch current item for merging arrays/images if needed (scoped by userId + tradeId)
    const current = await ddb.send(new GetCommand({ TableName: TRADES_TABLE, Key: { userId, tradeId } }));
    if (!current.Item || current.Item.deletedAt) return errorResponse(404, ErrorCodes.NOT_FOUND, 'Not found');
    const existing: any = current.Item;
    const prevUpdatedAt = existing.updatedAt;
    // Serialized before any change, so the update writes only the attributes this request changed.
    const before = new Map(Object.entries(existing).map(([k, v]) => [k, JSON.stringify(v)]));

    // partialCloses replaces the stored list (a retried PUT must not record a close twice).
    if (Array.isArray(data.partialCloses)) {
      existing.partialCloses = data.partialCloses
        .filter((pc: any) => pc && pc.quantity != null && pc.exitPrice != null)
        .map((pc: any) => ({ quantity: Number(pc.quantity), exitPrice: Number(pc.exitPrice), time: pc.time || new Date().toISOString() }));
      // Recalculate realizedPnL across partials; remaining position quantity.
      const entryPriceNum = existing.entryPrice != null ? Number(existing.entryPrice) : null;
      if (entryPriceNum != null) {
        let remaining = Number(existing.quantity);
        let realized = 0;
        for (const leg of existing.partialCloses) {
          if (remaining <= 0) break;
          const legQty = Math.min(remaining, Number(leg.quantity));
          realized += calcPnL({ ...existing, pnl: null, exitPrice: leg.exitPrice, quantity: legQty }) ?? 0;
          remaining -= legQty;
        }
        existing.realizedPartialPnl = realized;
        existing.remainingQuantity = remaining;
        if (remaining <= 0 && existing.exitPrice == null) {
          // If fully closed via partials set synthetic exitPrice = weighted average of closes
          const totalClosedQty = existing.partialCloses.reduce((a: number, l: any) => a + Number(l.quantity), 0);
          const weightedSum = existing.partialCloses.reduce((a: number, l: any) => a + Number(l.exitPrice) * Number(l.quantity), 0);
          if (totalClosedQty > 0) existing.exitPrice = Number((weightedSum / totalClosedQty).toFixed(5));
        }
      }
    }

    // Handle images with diff (full replacement semantics except unchanged-by-id kept).
    if (Array.isArray(data.images)) {
      const prevImages: any[] = Array.isArray(existing.images) ? existing.images : [];
      const incoming: any[] = data.images;
      const finalImages: any[] = [];
      // Build incoming map & process (upload only new base64 or changed content via new id)
      for (const raw of incoming) {
        const imgId = raw.id || uuid();
        const sentKey = typeof raw.key === 'string' ? raw.key : (typeof raw.id === 'string' && raw.id.startsWith('images/') ? raw.id : undefined);
        let existingImg = prevImages.find(i => i.id === imgId || (sentKey && i.key === sentKey));
        let url = existingImg?.url;
        // If client sent a data URI in the url field, normalize to base64Data path
        if (!raw.base64Data && typeof raw.url === 'string' && /^data:image\//i.test(raw.url)) {
          raw.base64Data = raw.url;
          delete raw.url; // prevent accidentally persisting data URI
        }
        // If base64 provided AND (new image or explicit replace request)
        if (raw.base64Data) {
          let b64 = raw.base64Data;
          const match = /^data:(.+);base64,(.*)$/i.exec(b64);
          let contentType = 'image/jpeg';
          if (match) { contentType = match[1]; b64 = match[2]; }
          if (!ALLOWED_IMAGE_TYPES.includes(contentType)) return errorResponse(400, ErrorCodes.VALIDATION_ERROR, `Unsupported image type: ${contentType}`);
          const buffer = Buffer.from(b64, 'base64');
          if (buffer.byteLength > MAX_IMAGE_BYTES) return errorResponse(400, ErrorCodes.VALIDATION_ERROR, 'Inline image exceeds 5MB limit');
          const ext = contentType === 'image/png' ? '.png' : contentType === 'image/gif' ? '.gif' : contentType === 'image/webp' ? '.webp' : '.jpg';
          const key = `images/${userId}/${tradeId}/${imgId}${ext}`;
          await s3.send(new PutObjectCommand({ Bucket: IMAGES_BUCKET, Key: key, Body: buffer, ContentType: contentType }));
          url = undefined;
          existingImg = { id: imgId, key };
          finalImages.push({ id: imgId, key, timeframe: raw.timeframe || null, description: raw.description || null });
          continue;
        } else if (typeof raw.key === 'string' && !existingImg) {
          // A key from POST /uploads/images: only the caller's own prefix may be attached.
          if (!raw.key.startsWith(`images/${userId}/`)) continue;
          finalImages.push({ id: imgId, key: raw.key, timeframe: raw.timeframe || null, description: raw.description || null });
          continue;
        } else if (raw.url) {
          // If incoming raw.url is actually an S3 key keep as key
          if (raw.url.startsWith('images/')) {
            // A key outside the caller's own prefix is dropped, never attached.
            if (!raw.url.startsWith(`images/${userId}/`)) continue;
            finalImages.push({ id: existingImg?.id ?? imgId, key: raw.url, timeframe: raw.timeframe || existingImg?.timeframe || null, description: raw.description || existingImg?.description || null });
            continue;
          } else {
            url = raw.url; // legacy external url fallback
          }
        }
        const merged = {
          id: existingImg?.id ?? imgId,
          ...(existingImg?.key ? { key: existingImg.key } : {}),
          ...(url ? { url } : {}),
          timeframe: raw.timeframe !== undefined ? raw.timeframe : (existingImg?.timeframe ?? null),
            description: raw.description !== undefined ? raw.description : (existingImg?.description ?? null)
        };
        finalImages.push(merged);
      }
      // Determine deletions: any previous image id not present in final list -> delete object
      const finalImageIds = new Set(finalImages.map(img => img.id));
      const toDeleteKeys = prevImages
        .filter(img => !finalImageIds.has(img.id))
        .map(img => {
          const k = img.key || normalizePotentialKey(img.url, IMAGES_BUCKET);
          return k ? { Key: k } : null;
        })
        .filter((entry): entry is { Key: string } => !!entry && (entry.Key.startsWith(`images/${userId}/${tradeId}/`) || entry.Key.startsWith(`images/${userId}/upload/`)));
      if (toDeleteKeys.length) {
        await s3.send(new DeleteObjectsCommand({ Bucket: IMAGES_BUCKET, Delete: { Objects: toDeleteKeys } }));
      }
      // Final sanitization: strip any base64/data URI remnants before persisting
      existing.images = finalImages.map(im => {
        const cleaned: any = { ...im };
        if (cleaned.base64Data) delete cleaned.base64Data;
        if (typeof cleaned.url === 'string' && /^data:image\//i.test(cleaned.url)) delete cleaned.url;
        return cleaned;
      });
    }

    // Direct field mapping helper - only fields from UI
    const mapable = ['symbol','side','quantity','openDate','closeDate','entryPrice','exitPrice','stopLoss','takeProfit','outcome','setupType','tradingSession','marketCondition','tradeNotes'];

    // Normalize numeric fields if provided as string
    if (data.pnl !== undefined) {
      const val = data.pnl;
      existing.pnl = (val === null || val === '') ? null : Number(val);
    }
    if (data.riskRewardRatio !== undefined) {
      const val = data.riskRewardRatio;
      existing.riskRewardRatio = (val === null || val === '') ? null : Number(val);
    }

    for (const f of mapable) if (f in data) existing[f] = data[f];
    const arrFields = ['mistakes','lessons','tags','newsEvents','brokenRuleIds'];
    for (const f of arrFields) if (Array.isArray(data[f])) existing[f] = data[f];
    // CONTRACT §6 fields: a value replaces the stored one, an explicit null (or '') removes it, absent leaves it.
    Object.assign(existing, contractFields(data));
    const removedFields = CONTRACT_FIELDS.filter((f) => f in data && (data[f] === null || data[f] === ''));
    for (const f of removedFields) delete existing[f];

    // Handle accountIds: if multiple accounts provided, handle multi-account logic
    const incomingAccountIds: string[] = Array.isArray(data.accountIds) && data.accountIds.length > 0 
      ? data.accountIds 
      : (data.accountId ? [data.accountId] : []);
    
    let additionalTrades: any[] = [];
    
    if (incomingAccountIds.length > 1) {
      // Multiple accounts selected: update existing trade with first accountId, create new trades for rest
      existing.accountId = incomingAccountIds[0];
      
      // Create additional trades for remaining accountIds
      for (let i = 1; i < incomingAccountIds.length; i++) {
        const { idempotencyKey: _idempotencyKey, ...copy } = existing;
        additionalTrades.push({
          ...copy,
          tradeId: uuid(),
          accountId: incomingAccountIds[i],
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        });
      }
    } else if (incomingAccountIds.length === 1) {
      // Single account: just update the accountId
      existing.accountId = incomingAccountIds[0];
    }
    // No accountIds in the body: the stored accountId stays as it is.

    // Recompute derived fields if relevant, but respect values passed in request
    // If request body includes pnl/netPnl, use those; otherwise calculate
    // Apply provided overrides first
    // `existing.pnl` already holds an explicit value from the body (null stays null). Without one, P&L is recomputed
    // only when an input of the formula changed or nothing is stored yet; a notes-only edit leaves it untouched.
    const pnlInputsChanged = ['entryPrice', 'exitPrice', 'quantity', 'side'].some((f) => f in data);
    const pnlChanged = 'pnl' in data || pnlInputsChanged || existing.pnl == null;
    if (!('pnl' in data) && (pnlInputsChanged || existing.pnl == null)) {
      const computed = calcPnL({ ...existing, pnl: null });
      if (computed !== undefined) existing.pnl = computed;
    }
    if ('netPnl' in data) {
      existing.netPnl = data.netPnl === null || data.netPnl === '' ? null : Number(data.netPnl);
    } else if (existing.pnl != null && (pnlChanged || existing.netPnl == null)) {
      const commission = existing.commission ? Number(existing.commission) : 0;
      const fees = existing.fees ? Number(existing.fees) : 0;
      existing.netPnl = existing.pnl - (commission + fees);
    }
    const riskAmount = existing.riskAmount ? Number(existing.riskAmount) : 0;
    // Calculate riskRewardRatio: use existing.pnl if present
    if (existing.pnl != null && riskAmount > 0) existing.riskRewardRatio = Number((existing.pnl / riskAmount).toFixed(4));
  // Do not auto-set outcome; keep whatever currently stored / provided
    existing.updatedAt = new Date().toISOString();
    const sets: string[] = []; const names: Record<string,string> = {}; const values: Record<string,any> = { ':u': userId };
    for (const [k,v] of Object.entries(existing)) {
      if (k === 'userId' || k === 'tradeId' || before.get(k) === JSON.stringify(v)) continue;
      names[`#${k}`] = k; values[`:${k}`] = v; sets.push(`#${k} = :${k}`);
    }
    const removes = removedFields.filter((f) => before.has(f));
    for (const f of removes) names[`#${f}`] = f;
    // Refuse to write over a concurrent edit or a soft delete that landed after the read above.
    if (prevUpdatedAt !== undefined) values[':prevUpdatedAt'] = prevUpdatedAt;
    const result = await ddb.send(new UpdateCommand({
      TableName: TRADES_TABLE,
      Key: { userId, tradeId },
      ConditionExpression: `userId = :u AND attribute_exists(tradeId) AND attribute_not_exists(deletedAt) AND ${prevUpdatedAt !== undefined ? 'updatedAt = :prevUpdatedAt' : 'attribute_not_exists(updatedAt)'}`,
      UpdateExpression: `SET ${sets.join(', ')}${removes.length ? ` REMOVE ${removes.map((f) => `#${f}`).join(', ')}` : ''}`,
      ExpressionAttributeNames: names,
      ExpressionAttributeValues: values,
      ReturnValues: 'ALL_NEW',
      ReturnValuesOnConditionCheckFailure: 'ALL_OLD',
    }));

    // Safe logging: omit large arrays / images content
    const safeLog = {
      tradeId,
      updatedFields: Object.keys(data).filter(k => k !== 'images' && k !== 'partialCloses'),
      imageCount: Array.isArray(existing.images) ? existing.images.length : 0,
      partialCloseCount: Array.isArray(existing.partialCloses) ? existing.partialCloses.length : 0,
      additionalTradesCreated: additionalTrades.length
    };
    log.info('Trade updated', safeLog);

    // Create additional trades for extra accounts
    const createdTrades: any[] = [];
    if (additionalTrades.length > 0) {
      for (const newTrade of additionalTrades) {
        // Each copy owns its screenshot objects, so removing or purging one trade never breaks another.
        if (Array.isArray(newTrade.images)) newTrade.images = await copyImagesToTrade(userId, newTrade.images, newTrade.tradeId);
        await ddb.send(new PutCommand({
          TableName: TRADES_TABLE,
          Item: newTrade
        }));
        createdTrades.push(newTrade);
        log.info('Additional trade created for account', { tradeId: newTrade.tradeId, accountId: newTrade.accountId });
      }
    }

    const saved = presentTrade(result.Attributes || {});
    const created = createdTrades.map(presentTrade);

    return envelope({ 
      statusCode: 200, 
      data: { trade: saved, createdTrades: created.length > 0 ? created : undefined },
      message: 'Updated'
    });
  } catch (e: any) {
    log.error('update-trade failed', { error: e.message, stack: e.stack });
    if (e.name === 'ConditionalCheckFailedException') {
      // ALL_OLD carries the stored item: a live one means another request changed it first.
      if (e.Item && !e.Item.deletedAt) return envelope({ statusCode: 409, error: { message: 'This trade was changed by another request. Reload it and try again.' } });
      return errorResponse(404, ErrorCodes.NOT_FOUND, 'Not found');
    }
    return errorFromException(e, true);
  }
};
