import { APIGatewayProxyHandlerV2 } from 'aws-lambda';
import { ddb } from '../../shared/dynamo';
import { GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { makeLogger } from '../../shared/logger';
import { S3Client, PutObjectCommand, DeleteObjectsCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { errorFromException } from '../../shared/validation';
import { v4 as uuid } from 'uuid';
import { normalizePotentialKey, extractKeyFromS3Url } from '../../shared/s3';

const TRADES_TABLE = process.env.TRADES_TABLE!;
const IMAGES_BUCKET = process.env.IMAGES_BUCKET!;
const s3 = new S3Client({});

export const handler: APIGatewayProxyHandlerV2 = async (event) => {
  const rc: any = event.requestContext as any;
  const userId = rc?.authorizer?.jwt?.claims?.sub;
  const requestId = event.requestContext.requestId;
  const log = makeLogger({ requestId, userId });
  try {
    if (!userId) return resp(401, { message: 'Unauthorized' });
    const tradeId = event.pathParameters?.tradeId;
    if (!tradeId) return resp(400, { message: 'Missing tradeId' });
    if (!event.body) return resp(400, { message: 'Missing body' });
    const data = JSON.parse(event.body);

    // Fetch current item for merging arrays/images if needed (scoped by userId + tradeId)
    const current = await ddb.send(new GetCommand({ TableName: TRADES_TABLE, Key: { userId, tradeId } }));
    if (!current.Item) return resp(404, { message: 'Not found' });
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
      // Determine deletions: any previous image id not present in incoming list -> delete object
      const toDeleteKeys = prevImages
        .filter(img => !incomingById.has(img.id) && typeof img.url === 'string')
        .map(img => normalizePotentialKey(img.url, IMAGES_BUCKET))
        .filter((k): k is string => !!k)
        .map(Key => ({ Key }));
      if (toDeleteKeys.length) {
        await s3.send(new DeleteObjectsCommand({ Bucket: IMAGES_BUCKET, Delete: { Objects: toDeleteKeys } }));
      }
  existing.images = finalImages;
    }

    // Direct field mapping helper
    const mapable = ['symbol','side','quantity','openDate','closeDate','entryPrice','exitPrice','stopLoss','takeProfit','commission','fees','riskAmount','setupType','timeframe','marketCondition','tradingSession','tradeGrade','confidence','setupQuality','execution','emotionalState','preTradeNotes','postTradeNotes','status'];
    for (const f of mapable) if (f in data) existing[f] = data[f];
    const arrFields = ['mistakes','lessons','tags','newsEvents','economicEvents'];
    for (const f of arrFields) if (Array.isArray(data[f])) existing[f] = data[f];
    if (data.psychology && typeof data.psychology === 'object') existing.psychology = { ...existing.psychology, ...data.psychology };

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
    existing.status = existing.status || (exitPrice != null ? 'CLOSED' : 'OPEN');
    existing.updatedAt = new Date().toISOString();
    // Update composite GSI attributes (symbol/date & status/date)
    if (existing.symbol && existing.openDate) {
      existing.symbolOpenDate = `${existing.symbol}#${existing.openDate}`;
    }
    if (existing.status && existing.openDate) {
      existing.statusOpenDate = `${existing.status}#${existing.openDate}`;
    }

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
      partialCloseCount: Array.isArray(existing.partialCloses) ? existing.partialCloses.length : 0
    };
    log.info('Trade updated', safeLog);
    const saved: any = result.Attributes || {};
    if (Array.isArray(saved.images)) {
      saved.images = await Promise.all(saved.images.map(async (im: any) => {
        const keyCandidate = im.key || normalizePotentialKey(im.url, IMAGES_BUCKET);
        if (keyCandidate) {
          const url = await getSignedUrl(s3, new GetObjectCommand({ Bucket: IMAGES_BUCKET, Key: keyCandidate }), { expiresIn: 900 });
          return { ...im, key: keyCandidate, url };
        }
        return im;
      }));
    }
    return resp(200, saved);
  } catch (e: any) {
    log.error('update-trade failed', { error: e.message, stack: e.stack });
    if (e.name === 'ConditionalCheckFailedException') return resp(404, { message: 'Not found' });
    return errorFromException(e, true);
  }
};

function resp(statusCode: number, body: any) { return { statusCode, body: JSON.stringify(body) }; }
