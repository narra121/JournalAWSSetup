import { SQSHandler, SQSEvent } from 'aws-lambda';
import { SQSClient, GetQueueAttributesCommand } from '@aws-sdk/client-sqs';
import { getApiKey, callGeminiWithRetry } from '../../shared/insights/gemini';
import { fetchTrades, fetchAggregatedStats } from '../../shared/insights/fetch-data';
import { parseCacheKey, writeCacheEntry, MIN_TRADES_THRESHOLD } from '../../shared/insights/cache';
import { buildInsightsPrompt, stripTradeForLLM } from '../../shared/insights/prompt';
import { extractJsonObject, validateInsightsResponse } from '../../shared/insights/validation';
import { detectPatterns, type PatternTrade } from '../../shared/pattern-detector';

const QUEUE_URL = process.env.REFRESH_INSIGHTS_QUEUE_URL!;
const sqs = new SQSClient({});

/** Minimum batch duration in ms. Configurable via env for testing. Default 62s. */
const MIN_BATCH_DURATION_MS = (() => {
  const v = parseInt(process.env.MIN_BATCH_DURATION_MS || '62000', 10);
  return Number.isFinite(v) && v >= 0 ? v : 62000;
})();

async function getQueueDepth(): Promise<number> {
  try {
    const res = await sqs.send(new GetQueueAttributesCommand({
      QueueUrl: QUEUE_URL,
      AttributeNames: ['ApproximateNumberOfMessages'],
    }));
    return parseInt(res.Attributes?.ApproximateNumberOfMessages || '0', 10);
  } catch {
    return 0;
  }
}

async function processRecord(userId: string, cacheKey: string): Promise<void> {
  const [accountId, startDate, endDate] = parseCacheKey(cacheKey);
  const normalizedAcct = accountId === 'all' ? undefined : accountId;

  const [trades, stats] = await Promise.all([
    fetchTrades(userId, startDate, endDate, normalizedAcct),
    fetchAggregatedStats(userId, startDate, endDate, normalizedAcct),
  ]);

  if (trades.length < MIN_TRADES_THRESHOLD) {
    console.log(`Skipping ${userId}/${cacheKey}: only ${trades.length} trades (min ${MIN_TRADES_THRESHOLD})`);
    return;
  }

  const patterns = detectPatterns(trades as PatternTrade[]);
  const strippedTrades = trades.map(stripTradeForLLM);
  const prompt = buildInsightsPrompt(stats, strippedTrades, patterns);

  const apiKey = await getApiKey();
  const rawResponse = await callGeminiWithRetry(apiKey, prompt);

  const { json } = extractJsonObject(rawResponse);
  if (!json) {
    console.error(`Failed to extract JSON for ${userId}/${cacheKey}`);
    return;
  }

  let parsed: any;
  try { parsed = JSON.parse(json); } catch { return; }

  if (!validateInsightsResponse(parsed)) {
    console.error(`Invalid response schema for ${userId}/${cacheKey}`);
    return;
  }

  const finalResponse = { ...parsed, patterns };
  const generatedAt = new Date().toISOString();
  await writeCacheEntry(userId, cacheKey, finalResponse, generatedAt);

  console.log(`Refreshed insights for ${userId}/${cacheKey}: ${trades.length} trades`);
}

export const handler: SQSHandler = async (event: SQSEvent) => {
  const startTime = Date.now();

  // 1. Deduplicate messages
  const unique = new Map<string, { userId: string; cacheKey: string }>();
  for (const record of event.Records) {
    try {
      const { userId, cacheKey } = JSON.parse(record.body);
      if (userId && cacheKey) {
        unique.set(`${userId}#${cacheKey}`, { userId, cacheKey });
      }
    } catch {
      console.warn('Failed to parse SQS message body:', record.body);
    }
  }

  if (unique.size === 0) return;

  console.log(`Processing ${unique.size} unique cache entries from ${event.Records.length} messages`);

  // 2. Process all in parallel (batch is already limited to 8 by SQS config)
  const results = await Promise.allSettled(
    [...unique.values()].map(({ userId, cacheKey }) =>
      processRecord(userId, cacheKey)
    )
  );

  // Log failures
  const failures = results.filter(r => r.status === 'rejected');
  if (failures.length > 0) {
    console.error(`${failures.length}/${unique.size} records failed:`,
      failures.map(f => (f as PromiseRejectedResult).reason?.message || 'unknown'));
  }

  // 3. Adaptive throttling
  const queueDepth = await getQueueDepth();
  if (queueDepth < 100) {
    const elapsed = Date.now() - startTime;
    if (elapsed < MIN_BATCH_DURATION_MS) {
      const waitMs = MIN_BATCH_DURATION_MS - elapsed;
      console.log(`Throttling: waiting ${waitMs}ms (queue depth: ${queueDepth})`);
      await new Promise(r => setTimeout(r, waitMs));
    }
  } else {
    console.log(`Burst mode: queue depth ${queueDepth}, skipping throttle`);
  }
};
