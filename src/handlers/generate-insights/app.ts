import { APIGatewayProxyHandlerV2 } from 'aws-lambda';
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';
import { QueryCommand, BatchGetCommand, PutCommand, GetCommand } from '@aws-sdk/lib-dynamodb';
import { ddb } from '../../shared/dynamo';
import { getUserId } from '../../shared/auth';
import { getSubscriptionTier } from '../../shared/subscription';
import { envelope, errorResponse, ErrorCodes } from '../../shared/validation';
import { aggregateDailyRecords } from '../../shared/stats-aggregator';
import { DailyStatsRecord, AggregatedStats } from '../../shared/metrics/types';

// ─── Constants ──────────────────────────────────────────────────

const MODELS = ['gemini-2.5-flash', 'gemini-3.0-flash-preview', 'gemini-2.5-pro'];
const GEMINI_API_BASE = 'https://generativelanguage.googleapis.com/v1beta';
const RETRYABLE_STATUS_CODES = [429, 500, 502, 503, 504];

const TRADES_TABLE = process.env.TRADES_TABLE!;
const DAILY_STATS_TABLE = process.env.DAILY_STATS_TABLE!;
const INSIGHTS_CACHE_TABLE = process.env.INSIGHTS_CACHE_TABLE!;

const REQUEST_TIMEOUT_MS = (() => {
  const v = parseInt(process.env.GEMINI_REQUEST_TIMEOUT_MS || '90000', 10);
  return Number.isFinite(v) && v > 0 ? v : 90000;
})();

const CACHE_COOLDOWN_MS = 6 * 60 * 60 * 1000; // 6 hours
const CACHE_TTL_DAYS = 30;
const MIN_TRADES_THRESHOLD = 10;
const MAX_TRADES_FOR_ANALYSIS = 500;

// ─── SSM API Key Cache ──────────────────────────────────────────

let cachedApiKey: string | undefined;
let apiKeyExpiry = 0;
const API_KEY_CACHE_TTL = 3600000; // 1 hour

const ssm = new SSMClient({});

async function getApiKey(): Promise<string> {
  if (cachedApiKey && Date.now() < apiKeyExpiry) return cachedApiKey;
  const paramName = process.env.GEMINI_API_KEY_PARAM;
  if (!paramName) throw new Error('Missing GEMINI_API_KEY_PARAM');
  const res = await ssm.send(new GetParameterCommand({ Name: paramName, WithDecryption: true }));
  const v = res.Parameter?.Value;
  if (!v) throw new Error('Gemini API key parameter empty');
  cachedApiKey = v;
  apiKeyExpiry = Date.now() + API_KEY_CACHE_TTL;
  return v;
}

// ─── Gemini API Call ────────────────────────────────────────────

async function callGemini(apiKey: string, prompt: string, outerSignal: AbortSignal): Promise<string> {
  const perModelTimeout = Math.floor(REQUEST_TIMEOUT_MS / MODELS.length);
  const errors: string[] = [];

  for (let i = 0; i < MODELS.length; i++) {
    const model = MODELS[i];
    const isLast = i === MODELS.length - 1;
    const url = `${GEMINI_API_BASE}/models/${model}:generateContent`;

    const modelController = new AbortController();
    const timeoutId = setTimeout(() => modelController.abort(), perModelTimeout);
    const onOuterAbort = () => modelController.abort();
    outerSignal.addEventListener('abort', onOuterAbort, { once: true });

    try {
      const resp = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0 },
        }),
        signal: modelController.signal,
      });

      if (!resp.ok) {
        const errorText = await resp.text();
        if (!isLast && RETRYABLE_STATUS_CODES.includes(resp.status)) {
          console.warn(`Gemini ${model} returned ${resp.status}, falling back to ${MODELS[i + 1]}`);
          errors.push(`${model}: ${resp.status}`);
          continue;
        }
        throw new Error(`Gemini API error: ${resp.status} ${resp.statusText} - ${errorText}`);
      }

      const data = await resp.json();
      const parts = data.candidates?.[0]?.content?.parts || [];
      const textPart = parts.find((p: any) => p.text);
      if (!textPart?.text) {
        if (!isLast) {
          console.warn(`Gemini ${model} returned empty response, falling back`);
          errors.push(`${model}: empty response`);
          continue;
        }
        throw new Error('Gemini returned empty response');
      }
      if (i > 0) console.log(`Used fallback model ${model} successfully`);
      return textPart.text.trim();
    } catch (err: any) {
      const isAbort = err?.name === 'AbortError';
      if (outerSignal.aborted) throw err;
      if (isAbort && !isLast) {
        console.warn(`Gemini ${model} timed out after ${perModelTimeout}ms, trying next model`);
        errors.push(`${model}: timeout`);
        continue;
      }
      if (!isLast && RETRYABLE_STATUS_CODES.some(code => err?.message?.includes(String(code)))) {
        errors.push(`${model}: ${err.message}`);
        continue;
      }
      throw err;
    } finally {
      clearTimeout(timeoutId);
      outerSignal.removeEventListener('abort', onOuterAbort);
    }
  }

  throw new Error(`All Gemini models failed: ${errors.join('; ')}`);
}

// ─── Types ──────────────────────────────────────────────────────

interface InsightsResponse {
  profile: {
    type: 'scalper' | 'day_trader' | 'swing_trader' | 'conservative';
    typeLabel: string;
    aggressivenessScore: number;
    aggressivenessLabel: string;
    trend: string | null;
    summary: string;
  };
  scores: Array<{
    dimension: string;
    value: number;
    label: string;
  }>;
  insights: Array<{
    severity: 'critical' | 'warning' | 'info' | 'strength';
    title: string;
    detail: string;
    evidence: string;
    tradeIds?: string[];
  }>;
  tradeSpotlights: Array<{
    tradeId: string;
    symbol: string;
    date: string;
    pnl: number;
    reason: string;
  }>;
  summary: string;
}

interface InsightsRequest {
  accountId?: string;
  startDate: string;
  endDate: string;
}

// ─── Trade Data Helpers ─────────────────────────────────────────

async function fetchTrades(
  userId: string,
  startDate: string,
  endDate: string,
  accountId?: string,
): Promise<any[]> {
  const inclusiveEnd = endDate.length === 10 ? endDate + 'T23:59:59.999Z' : endDate;

  // Step 1: Query GSI for keys (capped to prevent Gemini token overflow)
  const allKeys: Array<{ userId: string; tradeId: string }> = [];
  let exclusiveStartKey: Record<string, any> | undefined;

  do {
    const result = await ddb.send(
      new QueryCommand({
        TableName: TRADES_TABLE,
        IndexName: 'trades-by-date-gsi',
        KeyConditionExpression: 'userId = :u AND #od BETWEEN :start AND :end',
        ExpressionAttributeValues: { ':u': userId, ':start': startDate, ':end': inclusiveEnd },
        ExpressionAttributeNames: { '#od': 'openDate' },
        Limit: MAX_TRADES_FOR_ANALYSIS - allKeys.length,
        ExclusiveStartKey: exclusiveStartKey,
      }),
    );
    if (result.Items) {
      allKeys.push(...result.Items.map((it: any) => ({ userId: it.userId, tradeId: it.tradeId })));
    }
    exclusiveStartKey = result.LastEvaluatedKey;
  } while (exclusiveStartKey && allKeys.length < MAX_TRADES_FOR_ANALYSIS);

  if (allKeys.length === 0) return [];

  // Step 2: BatchGet full records in parallel chunks of 100
  const chunks: Array<Array<{ userId: string; tradeId: string }>> = [];
  for (let i = 0; i < allKeys.length; i += 100) {
    chunks.push(allKeys.slice(i, i + 100));
  }

  const batchResults = await Promise.all(
    chunks.map(chunk =>
      ddb.send(new BatchGetCommand({
        RequestItems: { [TRADES_TABLE]: { Keys: chunk } },
      })),
    ),
  );

  const fullItems: any[] = [];
  const unprocessedKeys: Array<Array<Record<string, any>>> = [];

  for (const batchResult of batchResults) {
    if (batchResult.Responses?.[TRADES_TABLE]) {
      fullItems.push(...batchResult.Responses[TRADES_TABLE]);
    }
    if (batchResult.UnprocessedKeys?.[TRADES_TABLE]?.Keys?.length) {
      unprocessedKeys.push(batchResult.UnprocessedKeys[TRADES_TABLE].Keys as Array<Record<string, any>>);
    }
  }

  // Retry unprocessed keys with backoff
  for (const retryKeys of unprocessedKeys) {
    let keysToRetry = retryKeys;
    let attempt = 0;
    while (keysToRetry.length > 0 && attempt < 3) {
      if (attempt > 0) {
        await new Promise(resolve => setTimeout(resolve, 50 * Math.pow(2, attempt)));
      }
      const retryResult = await ddb.send(new BatchGetCommand({
        RequestItems: { [TRADES_TABLE]: { Keys: keysToRetry } },
      }));
      if (retryResult.Responses?.[TRADES_TABLE]) {
        fullItems.push(...retryResult.Responses[TRADES_TABLE]);
      }
      keysToRetry = (retryResult.UnprocessedKeys?.[TRADES_TABLE]?.Keys as Array<Record<string, any>> | undefined) || [];
      attempt++;
    }
  }

  // Filter by accountId if specified
  if (accountId) {
    return fullItems.filter((it: any) => it.accountId === accountId);
  }

  return fullItems;
}

/**
 * Fetch DailyStats records and aggregate them.
 * Follows the same pattern as get-stats handler.
 */
async function fetchAggregatedStats(
  userId: string,
  startDate: string,
  endDate: string,
  accountId?: string,
): Promise<AggregatedStats> {
  const records = accountId
    ? await queryDailyStatsSingleAccount(userId, accountId, startDate, endDate)
    : await queryDailyStatsAllAccounts(userId, startDate, endDate);

  return aggregateDailyRecords(records);
}

async function queryDailyStatsAllAccounts(
  userId: string,
  startDate: string,
  endDate: string,
): Promise<DailyStatsRecord[]> {
  const records: DailyStatsRecord[] = [];
  let exclusiveStartKey: Record<string, any> | undefined;

  do {
    const result = await ddb.send(
      new QueryCommand({
        TableName: DAILY_STATS_TABLE,
        IndexName: 'stats-by-date-gsi',
        KeyConditionExpression: 'userId = :userId AND #date BETWEEN :startDate AND :endDate',
        ExpressionAttributeNames: { '#date': 'date' },
        ExpressionAttributeValues: {
          ':userId': userId,
          ':startDate': startDate,
          ':endDate': endDate,
        },
        ExclusiveStartKey: exclusiveStartKey,
      }),
    );
    if (result.Items) {
      records.push(...(result.Items as DailyStatsRecord[]));
    }
    exclusiveStartKey = result.LastEvaluatedKey;
  } while (exclusiveStartKey);

  return records;
}

async function queryDailyStatsSingleAccount(
  userId: string,
  accountId: string,
  startDate: string,
  endDate: string,
): Promise<DailyStatsRecord[]> {
  const records: DailyStatsRecord[] = [];
  let exclusiveStartKey: Record<string, any> | undefined;

  do {
    const result = await ddb.send(
      new QueryCommand({
        TableName: DAILY_STATS_TABLE,
        KeyConditionExpression: 'userId = :userId AND sk BETWEEN :skStart AND :skEnd',
        ExpressionAttributeValues: {
          ':userId': userId,
          ':skStart': `${accountId}#${startDate}`,
          ':skEnd': `${accountId}#${endDate}`,
        },
        ExclusiveStartKey: exclusiveStartKey,
      }),
    );
    if (result.Items) {
      records.push(...(result.Items as DailyStatsRecord[]));
    }
    exclusiveStartKey = result.LastEvaluatedKey;
  } while (exclusiveStartKey);

  return records;
}

// ─── Trade Stripping ────────────────────────────────────────────

const LLM_ESSENTIAL_FIELDS = [
  'tradeId', 'symbol', 'side', 'quantity', 'openDate', 'closeDate',
  'entryPrice', 'exitPrice', 'stopLoss', 'takeProfit', 'pnl', 'rrRatio',
  'accountId', 'outcome', 'strategy', 'fees', 'duration',
];
const LLM_TEXT_LIMITS: Record<string, number> = {
  notes: 100, keyLesson: 150, tags: 200, setups: 150, mistakes: 150,
};

function stripTradeForLLM(trade: any): any {
  const stripped: any = {};

  for (const field of LLM_ESSENTIAL_FIELDS) {
    if (field in trade) stripped[field] = trade[field];
  }

  for (const [field, maxLen] of Object.entries(LLM_TEXT_LIMITS)) {
    if (trade[field] && typeof trade[field] === 'string') {
      stripped[field] = trade[field].length > maxLen
        ? trade[field].slice(0, maxLen) + '...'
        : trade[field];
    }
  }

  return stripped;
}

// ─── Cache ──────────────────────────────────────────────────────

interface CacheRecord {
  userId: string;
  cacheKey: string;
  response: string; // JSON-serialized InsightsResponse
  generatedAt: string;
  stale: boolean;
  ttl: number;
}

function buildCacheKey(accountId: string | undefined, startDate: string, endDate: string): string {
  return `${accountId || 'all'}#${startDate}#${endDate}`;
}

async function getCacheEntry(userId: string, cacheKey: string): Promise<CacheRecord | null> {
  const result = await ddb.send(new GetCommand({
    TableName: INSIGHTS_CACHE_TABLE,
    Key: { userId, cacheKey },
  }));
  return (result.Item as CacheRecord | undefined) ?? null;
}

async function writeCacheEntry(
  userId: string,
  cacheKey: string,
  response: InsightsResponse,
  generatedAt: string,
): Promise<void> {
  const ttl = Math.floor(Date.now() / 1000) + CACHE_TTL_DAYS * 24 * 60 * 60;
  await ddb.send(new PutCommand({
    TableName: INSIGHTS_CACHE_TABLE,
    Item: {
      userId,
      cacheKey,
      response: JSON.stringify(response),
      generatedAt,
      stale: false,
      ttl,
    },
  }));
}

/**
 * Count trades created after a given timestamp to populate meta.newTradesSince.
 * Uses the trades-by-date-gsi to count trades with openDate > generatedAt.
 */
async function countTradesSince(
  userId: string,
  sinceTimestamp: string,
  endDate: string,
  accountId?: string,
): Promise<number> {
  let count = 0;
  let exclusiveStartKey: Record<string, any> | undefined;

  do {
    const result = await ddb.send(
      new QueryCommand({
        TableName: TRADES_TABLE,
        IndexName: 'trades-by-date-gsi',
        KeyConditionExpression: 'userId = :u AND #od BETWEEN :start AND :end',
        ExpressionAttributeValues: { ':u': userId, ':start': sinceTimestamp, ':end': endDate + 'T23:59:59.999Z' },
        ExpressionAttributeNames: { '#od': 'openDate' },
        Select: 'COUNT',
        ExclusiveStartKey: exclusiveStartKey,
      }),
    );
    count += result.Count || 0;
    exclusiveStartKey = result.LastEvaluatedKey;
  } while (exclusiveStartKey);

  return count;
}

// ─── Gemini Prompt ──────────────────────────────────────────────

function buildInsightsPrompt(stats: AggregatedStats, trades: any[]): string {
  return `ROLE:
You are an expert trading performance analyst. Your goal is to analyze the trader's historical data and produce a structured, actionable JSON response. Be specific, reference real data points, and cite individual trades by their tradeId when relevant.

TRADER PROFILING RULES:
Classify the trader into exactly one profile based on observed data patterns:

1. SCALPER (High-Frequency):
   - Signals: 5+ trades/day average, average hold time <1 hour, tight risk-reward (1:1 to 1.5:1), small gaps between trades
   - Focus insights on: overtrading detection, revenge trading, commission drag, fatigue patterns, best trading hours

2. DAY_TRADER:
   - Signals: 1-5 trades/day average, hold time 30min-8hrs, moderate risk-reward (1.5:1 to 2.5:1), trades within sessions
   - Focus insights on: session performance, strategy consistency, position sizing discipline, daily P&L targets

3. SWING_TRADER:
   - Signals: 2-10 trades/week average, hold time 1-14 days, wider risk-reward (2:1 to 4:1), gaps between trades
   - Focus insights on: entry timing, patience, holding through volatility, trend alignment

4. CONSERVATIVE (Low-Frequency):
   - Signals: <2 trades/week, high risk-reward (3:1+), low risk %, selective entries, long gaps between trades
   - Focus insights on: missed opportunities, entry quality, capital utilization, patience rewards

AGGRESSIVENESS SCORE (1-10):
Compute from these weighted factors relative to the trader's profile type:
- Trade frequency relative to profile norm
- Position sizing consistency and outliers
- Risk-reward ratio distribution
- Max drawdown severity
- Consecutive loss behavior (revenge trading signals)
- Rule-breaking frequency (if rule data available)
- Gap between trades (impulse trading detection)

Score interpretation:
- 1-3: "Conservative" — focus on capital utilization, scaling up safely
- 4-5: "Balanced" — focus on consistency, fine-tuning strategy
- 6-7: "Aggressive" — focus on risk management, drawdown control
- 8-10: "Very Aggressive" — focus on survival, risk reduction, emotional control

BEHAVIORAL SCORING (0-100 each):
Score these five dimensions based on the data:
- discipline: Following rules, sticking to plans, consistent behavior
- risk_management: Position sizing, stop losses, drawdown control
- consistency: Regularity of trading patterns, strategy adherence
- patience: Waiting for setups, not overtrading, appropriate hold times
- emotional_control: Revenge trading absence, consistency after losses, no tilt behavior

INSIGHT SEVERITY LEVELS:
- critical: Immediate action needed — patterns that are actively harmful
- warning: Concerning pattern that needs attention
- info: Neutral observation or suggestion for improvement
- strength: Positive reinforcement of good behavior

TRADE SPOTLIGHTS:
Highlight 3-5 notable trades: the best trade, the worst trade, and 1-3 trades that exemplify patterns you identified. Always include tradeId, symbol, date, pnl, and a reason explaining why this trade was highlighted.

RESPONSE JSON SCHEMA (you MUST return ONLY valid JSON matching this exact structure):
{
  "profile": {
    "type": "scalper" | "day_trader" | "swing_trader" | "conservative",
    "typeLabel": "string (Human-readable label, e.g. 'Day Trader')",
    "aggressivenessScore": "number (1-10)",
    "aggressivenessLabel": "string ('Conservative' | 'Balanced' | 'Aggressive' | 'Very Aggressive')",
    "trend": "string | null (e.g. 'up_from_5.4', 'stable', 'down_from_7.1'; null for first analysis)",
    "summary": "string (One-line profile summary)"
  },
  "scores": [
    {
      "dimension": "string (one of: discipline, risk_management, consistency, patience, emotional_control)",
      "value": "number (0-100)",
      "label": "string (Human-readable dimension name, e.g. 'Risk Management')"
    }
  ],
  "insights": [
    {
      "severity": "critical" | "warning" | "info" | "strength",
      "title": "string (Short headline)",
      "detail": "string (Explanation with evidence)",
      "evidence": "string (Specific data point backing the insight)",
      "tradeIds": ["string (optional, specific trade IDs referenced)"]
    }
  ],
  "tradeSpotlights": [
    {
      "tradeId": "string",
      "symbol": "string",
      "date": "string (ISO date)",
      "pnl": "number",
      "reason": "string (Why this trade was highlighted)"
    }
  ],
  "summary": "string (One-paragraph overall assessment)"
}

STRICT OUTPUT RULES:
- Return ONLY valid JSON. No markdown fences, no leading/trailing text, no explanations.
- The "scores" array must contain exactly 5 entries, one for each dimension listed above.
- The "insights" array should contain 4-8 insights, severity-ordered (critical first, then warning, info, strength).
- The "tradeSpotlights" array should contain 3-5 entries.
- Only include tradeIds in insights if you are referencing specific trades.
- All numeric values must be actual numbers, not strings.
- trend should be null since this is a standalone analysis.

AGGREGATED STATS:
${JSON.stringify(stats, null, 2)}

TRADE DATA (${trades.length} trades):
${JSON.stringify(trades, null, 2)}`;
}

// ─── JSON Extraction ────────────────────────────────────────────

function extractJsonObject(raw: string): { json?: string; steps: string[] } {
  const steps: string[] = [];
  let work = raw.trim();

  // Strip markdown code fences if present
  const fenceMatch = work.match(/```(?:json)?\s*[\r\n]+([\s\S]*?)```/i);
  if (fenceMatch) {
    steps.push('Stripped markdown code fence');
    work = fenceMatch[1].trim();
  }

  // Direct check for JSON object
  if (work.startsWith('{') && work.endsWith('}')) {
    try {
      JSON.parse(work);
      steps.push('Detected and validated object boundaries directly');
      return { json: work, steps };
    } catch {
      steps.push('Direct boundaries detected but invalid JSON, falling through');
    }
  }

  // String-aware bracket balancing to find first JSON object
  const firstOpen = work.indexOf('{');
  if (firstOpen !== -1) {
    let depth = 0;
    let inString = false;
    let escaped = false;

    for (let i = firstOpen; i < work.length; i++) {
      const ch = work[i];

      if (escaped) {
        escaped = false;
        continue;
      }

      if (ch === '\\' && inString) {
        escaped = true;
        continue;
      }

      if (ch === '"') {
        inString = !inString;
        continue;
      }

      if (inString) continue;

      if (ch === '{') depth++;
      else if (ch === '}') {
        depth--;
        if (depth === 0) {
          const candidate = work.slice(firstOpen, i + 1);
          try {
            JSON.parse(candidate);
            steps.push('Extracted and validated balanced object slice');
            return { json: candidate, steps };
          } catch {
            steps.push('Balanced slice found but invalid JSON');
          }
          break;
        }
      }
    }
  }

  return { steps };
}

// ─── Response Validation ────────────────────────────────────────

function validateInsightsResponse(data: any): data is InsightsResponse {
  if (!data || typeof data !== 'object') return false;

  // Validate profile
  if (!data.profile || typeof data.profile !== 'object') return false;
  const validTypes = ['scalper', 'day_trader', 'swing_trader', 'conservative'];
  if (!validTypes.includes(data.profile.type)) return false;
  if (typeof data.profile.aggressivenessScore !== 'number') return false;
  if (typeof data.profile.summary !== 'string') return false;

  // Validate scores array
  if (!Array.isArray(data.scores) || data.scores.length === 0) return false;
  for (const score of data.scores) {
    if (typeof score.dimension !== 'string') return false;
    if (typeof score.value !== 'number') return false;
  }

  // Validate insights array
  if (!Array.isArray(data.insights)) return false;
  const validSeverities = ['critical', 'warning', 'info', 'strength'];
  for (const insight of data.insights) {
    if (!validSeverities.includes(insight.severity)) return false;
    if (typeof insight.title !== 'string') return false;
    if (typeof insight.detail !== 'string') return false;
  }

  // Validate tradeSpotlights array
  if (!Array.isArray(data.tradeSpotlights)) return false;

  // Validate summary
  if (typeof data.summary !== 'string') return false;

  return true;
}

// ─── Handler ────────────────────────────────────────────────────

export const handler: APIGatewayProxyHandlerV2 = async (event) => {
  try {
    const userId = getUserId(event);
    if (!userId) return errorResponse(401, ErrorCodes.UNAUTHORIZED, 'Unauthorized');

    // Subscription gate — premium only
    const tierResult = await getSubscriptionTier(userId);
    if (tierResult.tier === 'free_with_ads') {
      return errorResponse(403, ErrorCodes.SUBSCRIPTION_REQUIRED, 'AI Insights requires a premium subscription');
    }

    // Parse request body
    if (!event.body) {
      return errorResponse(400, ErrorCodes.VALIDATION_ERROR, 'Missing request body');
    }

    let request: InsightsRequest;
    try {
      request = JSON.parse(event.body);
    } catch {
      return errorResponse(400, ErrorCodes.VALIDATION_ERROR, 'Body must be valid JSON');
    }

    const { accountId: rawAccountId, startDate, endDate } = request;
    const accountId = rawAccountId && rawAccountId !== 'ALL' ? rawAccountId : undefined;
    if (!startDate || !endDate) {
      return errorResponse(400, ErrorCodes.VALIDATION_ERROR, 'startDate and endDate are required');
    }

    const started = Date.now();

    // ─── Cache Check ──────────────────────────────────────────
    const cacheKey = buildCacheKey(accountId, startDate, endDate);

    try {
      const cacheEntry = await getCacheEntry(userId, cacheKey);

      if (cacheEntry && !cacheEntry.stale) {
        const generatedAt = new Date(cacheEntry.generatedAt).getTime();
        const age = Date.now() - generatedAt;

        if (age < CACHE_COOLDOWN_MS) {
          // Cache hit — return cached response
          const cachedResponse = JSON.parse(cacheEntry.response) as InsightsResponse;

          // Count new trades since generation
          const newTradesSince = await countTradesSince(userId, cacheEntry.generatedAt, endDate, accountId);

          const elapsed = Date.now() - started;
          return envelope({
            statusCode: 200,
            data: cachedResponse,
            meta: {
              cached: true,
              generatedAt: cacheEntry.generatedAt,
              newTradesSince,
              elapsedMs: elapsed,
            },
            message: 'Insights retrieved from cache',
          });
        }
      }
    } catch (cacheError) {
      // Cache read failure is non-fatal — proceed to generate fresh insights
      console.error('Cache read failed, proceeding to generate', cacheError);
    }

    // ─── Fetch Data ───────────────────────────────────────────

    // Fetch trades and stats in parallel
    const [trades, stats] = await Promise.all([
      fetchTrades(userId, startDate, endDate, accountId),
      fetchAggregatedStats(userId, startDate, endDate, accountId),
    ]);

    // Minimum trade threshold
    if (trades.length < MIN_TRADES_THRESHOLD) {
      return envelope({
        statusCode: 200,
        data: null,
        error: {
          code: 'INSUFFICIENT_DATA',
          message: `Not enough trades in this period for meaningful insights. Found ${trades.length} trades, minimum is ${MIN_TRADES_THRESHOLD}. Try expanding your date range.`,
        },
        meta: { tradeCount: trades.length, minRequired: MIN_TRADES_THRESHOLD },
        message: 'Insufficient trade data for analysis',
      });
    }

    // Strip heavy fields from trades before sending to Gemini
    const strippedTrades = trades.map(stripTradeForLLM);

    // ─── Build Prompt & Call Gemini ───────────────────────────

    const prompt = buildInsightsPrompt(stats, strippedTrades);

    let apiKey: string;
    try {
      apiKey = await getApiKey();
    } catch (e: any) {
      return envelope({
        statusCode: 500,
        error: { code: 'ConfigError', message: e.message },
        message: e.message,
      });
    }

    console.log('GenerateInsights calling Gemini', {
      userId,
      tradeCount: trades.length,
      promptLength: prompt.length,
      startDate,
      endDate,
      accountId: accountId || 'all',
    });

    let geminiText: string;
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

      geminiText = await callGemini(apiKey, prompt, controller.signal);

      clearTimeout(timeoutId);
    } catch (err: any) {
      const elapsed = Date.now() - started;
      const isAbort = err?.name === 'AbortError' || /aborted/i.test(err?.message || '');
      return envelope({
        statusCode: 500,
        error: {
          code: isAbort ? 'GeminiTimeout' : 'GeminiError',
          message: isAbort
            ? `Request timed out after ${REQUEST_TIMEOUT_MS / 1000}s. Try a narrower date range.`
            : (err?.message || 'AI processing failed'),
        },
        meta: { elapsedMs: elapsed },
        message: 'Insights generation failed',
      });
    }

    // ─── Parse & Validate Response ────────────────────────────

    const extracted = extractJsonObject(geminiText);
    if (!extracted.json) {
      const elapsed = Date.now() - started;
      console.error('Gemini did not return valid JSON', { rawPreview: geminiText.slice(0, 500) });
      return envelope({
        statusCode: 500,
        error: {
          code: 'ParseError',
          message: 'AI returned an unparseable response. Please try again.',
        },
        meta: { elapsedMs: elapsed, parseSteps: extracted.steps },
        message: 'Failed to parse AI response',
      });
    }

    let insightsResponse: InsightsResponse;
    try {
      insightsResponse = JSON.parse(extracted.json);
    } catch (parseErr: any) {
      const elapsed = Date.now() - started;
      console.error('JSON parse error', { error: parseErr.message, rawPreview: extracted.json.slice(0, 500) });
      return envelope({
        statusCode: 500,
        error: {
          code: 'ParseError',
          message: 'AI returned malformed JSON. Please try again.',
        },
        meta: { elapsedMs: elapsed },
        message: 'Failed to parse AI response',
      });
    }

    if (!validateInsightsResponse(insightsResponse)) {
      const elapsed = Date.now() - started;
      const raw = insightsResponse as any;
      console.error('Insights response validation failed', {
        hasProfile: !!raw.profile,
        hasScores: Array.isArray(raw.scores),
        hasInsights: Array.isArray(raw.insights),
      });
      return envelope({
        statusCode: 500,
        error: {
          code: 'ValidationError',
          message: 'AI response did not match expected schema. Please try again.',
        },
        meta: { elapsedMs: elapsed },
        message: 'AI response validation failed',
      });
    }

    // ─── Cache Result ─────────────────────────────────────────

    const generatedAt = new Date().toISOString();

    try {
      await writeCacheEntry(userId, cacheKey, insightsResponse, generatedAt);
    } catch (cacheWriteError) {
      // Cache write failure is non-fatal — log and continue
      console.error('Cache write failed', cacheWriteError);
    }

    // ─── Return Response ──────────────────────────────────────

    const elapsed = Date.now() - started;

    console.log('GenerateInsights completed', {
      userId,
      tradeCount: trades.length,
      profileType: insightsResponse.profile.type,
      insightCount: insightsResponse.insights.length,
      elapsedMs: elapsed,
    });

    return envelope({
      statusCode: 200,
      data: insightsResponse,
      meta: {
        cached: false,
        generatedAt,
        newTradesSince: 0,
        elapsedMs: elapsed,
        tradeCount: trades.length,
      },
      message: 'Insights generated successfully',
    });
  } catch (e: any) {
    console.error('GenerateInsights error', e);
    return envelope({
      statusCode: 500,
      error: { code: ErrorCodes.INTERNAL_ERROR, message: e?.message || 'Unexpected error' },
      message: 'Internal error',
    });
  }
};
