import { APIGatewayProxyHandlerV2 } from 'aws-lambda';
import { ddb } from '../../shared/dynamo';
import { GetCommand, UpdateCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import { makeLogger } from '../../shared/logger';
import { S3Client, PutObjectCommand, DeleteObjectsCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { errorFromException, envelope, errorResponse, ErrorCodes } from '../../shared/validation';
import { v4 as uuid } from 'uuid';
import { normalizePotentialKey, extractKeyFromS3Url } from '../../shared/s3';
import { getUserId } from '../../shared/auth';
import { checkSubscription } from '../../shared/subscription';

const TRADES_TABLE = process.env.TRADES_TABLE!;
const IMAGES_BUCKET = process.env.IMAGES_BUCKET!;
const s3 = new S3Client({});

export const handler: APIGatewayProxyHandlerV2 = async (event) => {
  const userId = getUserId(event);
  const requestId = event.requestContext.requestId;
  const log = makeLogger({ requestId, userId });
  try {
    if (!userId) return errorResponse(401, ErrorCodes.UNAUTHORIZED, 'Unauthorized');

    const subError = await checkSubscription(userId);
    if (subError) return subError;

    const tradeId = event.pathParameters?.tradeId;
    if (!tradeId) return errorResponse(400, ErrorCodes.VALIDATION_ERROR, 'Missing tradeId');
    if (!event.body) return errorResponse(400, ErrorCodes.VALIDATION_ERROR, 'Missing body');
    let data: any;
    try { data = JSON.parse(event.body); } catch { return errorResponse(400, ErrorCodes.VALIDATION_ERROR, 'Invalid JSON'); }

    // Fetch current item for merging arrays/images if needed (scoped by userId + tradeId)
    const current = await ddb.send(new GetCommand({ TableName: TRADES_TABLE, Key: { userId, tradeId } }));
    if (!current.Item) return errorResponse(404, ErrorCodes.NOT_FOUND, 'Not found');
    const existing: any = current.Item;

    // Handle partial closes: if data.partialCloses is array of { quantity, exitPrice, time } apply FIFO reduction.
    if (Array.isArray(data.partialCloses) && data.partialCloses.length) {
      existing.partialCloses = existing.partialCloses || [];
      for (const pc of data.partialCloses) {
        if (!pc || pc.quantity == null || pc.exitPrice == null) continue;
        existing.partialCloses.push({ quantity: Number(pc.quantity), exitPrice: Number(pc.exitPrice), time: pc.time || new Date().toISOString() });
      }
      // Recalculate realizedPnL across partials; remaining position quantity.
      const entryPriceNum = existing.entryPrice != null ? Number(existing.entryPrice) : null;
      if (entryPriceNum != null) {
        let remaining = Number(existing.quantity);
        let realized = 0;
        for (const leg of existing.partialCloses) {
          if (remaining <= 0) break;
            const legQty = Math.min(remaining, Number(leg.quantity));
            const legPnl = existing.side === 'BUY' ? (Number(leg.exitPrice) - entryPriceNum) * legQty : (entryPriceNum - Number(leg.exitPrice)) * legQty;
            realized += legPnl;
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
      const incomingById = new Map<string, any>();
      const finalImages: any[] = [];
      // Build incoming map & process (upload only new base64 or changed content via new id)
      for (const raw of incoming) {
        const imgId = raw.id || uuid();
        let existingImg = prevImages.find(i => i.id === imgId);
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
          const buffer = Buffer.from(b64, 'base64');
          const ext = contentType === 'image/png' ? '.png' : contentType === 'image/gif' ? '.gif' : '.jpg';
          const key = `images/${userId}/${tradeId}/${imgId}${ext}`;
          await s3.send(new PutObjectCommand({ Bucket: IMAGES_BUCKET, Key: key, Body: buffer, ContentType: contentType }));
          url = undefined;
          existingImg = { id: imgId, key };
          finalImages.push({ id: imgId, key, timeframe: raw.timeframe || null, description: raw.description || null });
          continue;
        } else if (raw.url) {
          // If incoming raw.url is actually an S3 key keep as key
          if (raw.url.startsWith('images/')) {
            finalImages.push({ id: imgId, key: raw.url, timeframe: raw.timeframe || existingImg?.timeframe || null, description: raw.description || existingImg?.description || null });
            continue;
          } else {
            url = raw.url; // legacy external url fallback
          }
        }
        const merged = {
          id: imgId,
          ...(existingImg?.key ? { key: existingImg.key } : {}),
          ...(url ? { url } : {}),
          timeframe: raw.timeframe !== undefined ? raw.timeframe : (existingImg?.timeframe ?? null),
            description: raw.description !== undefined ? raw.description : (existingImg?.description ?? null)
        };
        incomingById.set(imgId, merged);
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
        .filter((entry): entry is { Key: string } => !!entry);
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
    
    // Handle accountIds: if multiple accounts provided, handle multi-account logic
    const incomingAccountIds: string[] = Array.isArray(data.accountIds) && data.accountIds.length > 0 
      ? data.accountIds 
      : (data.accountId ? [data.accountId] : []);
    
    const existingAccountId = existing.accountId || '-1';
    let additionalTrades: any[] = [];
    
    if (incomingAccountIds.length > 1) {
      // Multiple accounts selected: update existing trade with first accountId, create new trades for rest
      existing.accountId = incomingAccountIds[0];
      
      // Create additional trades for remaining accountIds
      for (let i = 1; i < incomingAccountIds.length; i++) {
        const newTradeId = uuid();
        const newTrade: any = { 
          ...existing, 
          tradeId: newTradeId, 
          accountId: incomingAccountIds[i],
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString()
        };
        additionalTrades.push(newTrade);
      }
    } else if (incomingAccountIds.length === 1) {
      // Single account: just update the accountId
      existing.accountId = incomingAccountIds[0];
    } else {
      // No accountIds provided: store as -1
      existing.accountId = '-1';
    }

    // Recompute derived fields if relevant, but respect values passed in request
    // If request body includes pnl/netPnl, use those; otherwise calculate
    const entryPrice = existing.entryPrice != null ? Number(existing.entryPrice) : null;
    const exitPrice = existing.exitPrice != null ? Number(existing.exitPrice) : null;
    const quantityNum = existing.quantity != null ? Number(existing.quantity) : null;
    // Apply provided overrides first
    if ('pnl' in data) {
      existing.pnl = Number(data.pnl);
    } else if (entryPrice != null && exitPrice != null && quantityNum != null) {
      existing.pnl = existing.side === 'BUY'
        ? (exitPrice - entryPrice) * quantityNum
        : (entryPrice - exitPrice) * quantityNum;
    }
    if ('netPnl' in data) {
      existing.netPnl = Number(data.netPnl);
    } else if (existing.pnl != null) {
      const commission = existing.commission ? Number(existing.commission) : 0;
      const fees = existing.fees ? Number(existing.fees) : 0;
      existing.netPnl = existing.pnl - (commission + fees);
    }
    const riskAmount = existing.riskAmount ? Number(existing.riskAmount) : 0;
    // Calculate riskRewardRatio: use existing.pnl if present
    existing.riskRewardRatio = existing.pnl != null && riskAmount > 0
      ? Number((existing.pnl / riskAmount).toFixed(4))
      : null;
  // Do not auto-set outcome; keep whatever currently stored / provided
    existing.updatedAt = new Date().toISOString();
    // Persist full object (replace strategy) with stricter condition (must belong to user and exist)
    const sets: string[] = []; const names: Record<string,string> = {}; const values: Record<string,any> = { ':u': userId };
    for (const [k,v] of Object.entries(existing)) { if (k === 'userId' || k === 'tradeId') continue; const nk = `#${k}`; const vk = `:${k}`; names[nk] = k; values[vk] = v; sets.push(`${nk} = ${vk}`);}    
    const result = await ddb.send(new UpdateCommand({
      TableName: TRADES_TABLE,
      Key: { userId, tradeId },
      ConditionExpression: 'userId = :u AND attribute_exists(tradeId)',
      UpdateExpression: 'SET ' + sets.join(', '),
      ExpressionAttributeNames: names,
      ExpressionAttributeValues: values,
      ReturnValues: 'ALL_NEW'
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
        await ddb.send(new PutCommand({
          TableName: TRADES_TABLE,
          Item: newTrade
        }));
        createdTrades.push(newTrade);
        log.info('Additional trade created for account', { tradeId: newTrade.tradeId, accountId: newTrade.accountId });
      }
    }

  const saved: any = result.Attributes || {};
  if (saved.achievedRiskRewardRatio === undefined) saved.achievedRiskRewardRatio = null;
  // Remove accountIds field (legacy) - each trade has only one accountId
  if (saved.accountIds) delete saved.accountIds;
    if (Array.isArray(saved.images)) {
      saved.images = saved.images.map((im: any) => {
        const keyCandidate = im.key || normalizePotentialKey(im.url, IMAGES_BUCKET);
        if (keyCandidate) {
          // Return image ID instead of signed URL
          return { ...im, id: keyCandidate, key: keyCandidate };
        }
        return { ...im, id: im.id || im.key || '' };
      });
    }
    
    // Process images for additional trades and return all trades
    const allTrades = [saved];
    for (const ct of createdTrades) {
      // Remove accountIds field (legacy) - each trade has only one accountId
      if (ct.accountIds) delete ct.accountIds;
      if (Array.isArray(ct.images)) {
        ct.images = ct.images.map((im: any) => {
          const keyCandidate = im.key || normalizePotentialKey(im.url, IMAGES_BUCKET);
          if (keyCandidate) {
            // Return image ID instead of signed URL
            return { ...im, id: keyCandidate, key: keyCandidate };
          }
          return { ...im, id: im.id || im.key || '' };
        });
      }
      allTrades.push(ct);
    }
    
    return envelope({ 
      statusCode: 200, 
      data: { trade: saved, createdTrades: createdTrades.length > 0 ? createdTrades : undefined },
      message: 'Updated'
    });
  } catch (e: any) {
    log.error('update-trade failed', { error: e.message, stack: e.stack });
    if (e.name === 'ConditionalCheckFailedException') return errorResponse(404, ErrorCodes.NOT_FOUND, 'Not found');
    return errorFromException(e, true);
  }
};
