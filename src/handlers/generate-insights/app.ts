import { APIGatewayProxyHandlerV2 } from 'aws-lambda';
import { getUserId } from '../../shared/auth';
import { getSubscriptionTier } from '../../shared/subscription';
import { envelope, errorResponse, ErrorCodes } from '../../shared/validation';
import {
  getApiKey,
  callGemini,
  REQUEST_TIMEOUT_MS,
  fetchTrades,
  fetchAggregatedStats,
  stripTradeForLLM,
  buildInsightsPrompt,
  buildCacheKey,
  getCacheEntry,
  writeCacheEntry,
  MIN_TRADES_THRESHOLD,
  extractJsonObject,
  validateInsightsResponse,
} from '../../shared/insights';
import type { InsightsResponse } from '../../shared/insights';
import { detectPatterns } from '../../shared/pattern-detector';
import type { PatternTrade } from '../../shared/pattern-detector';

interface InsightsRequest {
  accountId?: string;
  startDate: string;
  endDate: string;
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
        const elapsed = Date.now() - started;
        return envelope({
          statusCode: 200,
          data: JSON.parse(cacheEntry.response),
          meta: {
            cached: true,
            generatedAt: cacheEntry.generatedAt,
            newTradesSince: 0,
            upToDate: true,
            elapsedMs: elapsed,
          },
          message: 'Insights retrieved from cache',
        });
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

    // Run deterministic pattern detection on full trades
    const patterns = detectPatterns(trades as PatternTrade[]);

    // Strip heavy fields from trades before sending to Gemini
    const strippedTrades = trades.map(stripTradeForLLM);

    // ─── Build Prompt & Call Gemini ───────────────────────────

    const prompt = buildInsightsPrompt(stats, strippedTrades, patterns);

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

    // ─── Merge Patterns into Response ───────────────────────────

    const finalResponse = { ...insightsResponse, patterns };

    // ─── Cache Result ─────────────────────────────────────────

    const generatedAt = new Date().toISOString();

    try {
      await writeCacheEntry(userId, cacheKey, finalResponse, generatedAt);
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
      data: finalResponse,
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
