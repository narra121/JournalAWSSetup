import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import 'aws-sdk-client-mock-jest';
import {
  DynamoDBDocumentClient,
  PutCommand,
  QueryCommand,
  BatchGetCommand,
} from '@aws-sdk/lib-dynamodb';
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';
import { SQSClient, GetQueueAttributesCommand } from '@aws-sdk/client-sqs';
import type { SQSEvent } from 'aws-lambda';

// Stub env BEFORE importing handler
vi.stubEnv('TRADES_TABLE', 'test-trades');
vi.stubEnv('DAILY_STATS_TABLE', 'test-daily-stats');
vi.stubEnv('INSIGHTS_CACHE_TABLE', 'test-insights-cache');
vi.stubEnv('GEMINI_API_KEY_PARAM', '/test/gemini-key');
vi.stubEnv('GEMINI_REQUEST_TIMEOUT_MS', '5000');
vi.stubEnv('REFRESH_INSIGHTS_QUEUE_URL', 'https://sqs.us-east-1.amazonaws.com/123456/test-queue');
vi.stubEnv('MIN_BATCH_DURATION_MS', '0'); // Disable throttle sleep for most tests
vi.stubEnv('STAGE', 'test');

// Mock DynamoDB, SSM, SQS
const ddbMock = mockClient(DynamoDBDocumentClient);
const ssmMock = mockClient(SSMClient);
const sqsMock = mockClient(SQSClient);

// Mock global fetch
const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

// Mock stats aggregator
vi.mock('../../../shared/stats-aggregator', () => ({
  aggregateDailyRecords: vi.fn(),
}));

const { handler } = await import('../app.ts');

// Import mock references after vi.mock
const { aggregateDailyRecords } = await import('../../../shared/stats-aggregator');

// ---- Helpers ----

function makeSQSEvent(records: Array<{ userId: string; cacheKey: string }>): SQSEvent {
  return {
    Records: records.map((r, i) => ({
      messageId: `msg-${i}`,
      receiptHandle: `handle-${i}`,
      body: JSON.stringify(r),
      attributes: {} as any,
      messageAttributes: {},
      md5OfBody: '',
      eventSource: 'aws:sqs',
      eventSourceARN: 'arn:aws:sqs:us-east-1:123456:test-queue',
      awsRegion: 'us-east-1',
    })),
  };
}

function makeSampleInsightsResponse() {
  return {
    profile: {
      type: 'day_trader',
      typeLabel: 'Day Trader',
      aggressivenessScore: 5,
      aggressivenessLabel: 'Balanced',
      trend: null,
      summary: 'Balanced day trader with consistent patterns.',
    },
    scores: [
      { dimension: 'discipline', value: 75, label: 'Discipline' },
      { dimension: 'risk_management', value: 60, label: 'Risk Management' },
      { dimension: 'consistency', value: 80, label: 'Consistency' },
      { dimension: 'patience', value: 55, label: 'Patience' },
      { dimension: 'emotional_control', value: 70, label: 'Emotional Control' },
    ],
    insights: [
      { severity: 'warning', title: 'Inconsistent sizing', detail: 'Position sizes vary', evidence: 'StdDev 2.5x mean' },
      { severity: 'strength', title: 'Good win rate', detail: '60% win rate', evidence: '9/15 trades profitable' },
    ],
    tradeSpotlights: [
      { tradeId: 'trade-1', symbol: 'EURUSD', date: '2026-04-10', pnl: 100, reason: 'Best trade' },
      { tradeId: 'trade-5', symbol: 'XAUUSD', date: '2026-04-12', pnl: -50, reason: 'Worst loss' },
      { tradeId: 'trade-8', symbol: 'GBPUSD', date: '2026-04-14', pnl: 30, reason: 'Over-leverage' },
    ],
    summary: 'Overall a balanced day trader showing solid fundamentals.',
  };
}

function makeSampleTrades(count: number): any[] {
  const trades: any[] = [];
  for (let i = 0; i < count; i++) {
    trades.push({
      userId: 'user-1',
      tradeId: `trade-${i}`,
      symbol: i % 2 === 0 ? 'EURUSD' : 'XAUUSD',
      side: i % 2 === 0 ? 'BUY' : 'SELL',
      quantity: 1,
      accountId: 'acc-1',
      openDate: `2026-04-${String(1 + (i % 28)).padStart(2, '0')}T10:00:00`,
      closeDate: `2026-04-${String(1 + (i % 28)).padStart(2, '0')}T11:00:00`,
      entryPrice: 1.1 + i * 0.001,
      exitPrice: 1.101 + i * 0.001,
      stopLoss: 1.099,
      takeProfit: 1.102,
      pnl: (i % 3 === 0) ? -(5 + i) : (10 + i),
      images: ['base64encodeddata'],
      notes: 'Some trade notes',
    });
  }
  return trades;
}

const mockAggregatedStats = {
  totalTrades: 15,
  winCount: 10,
  lossCount: 5,
  winRate: 66.67,
  totalPnl: 150,
  avgPnl: 10,
  maxDrawdown: -30,
  profitFactor: 2.5,
};

function mockGeminiSuccess(response: any = makeSampleInsightsResponse()) {
  fetchMock.mockResolvedValueOnce({
    ok: true,
    json: async () => ({
      candidates: [{ content: { parts: [{ text: JSON.stringify(response) }] } }],
    }),
  });
}

// ---- Default mock setup ----

function setupDefaultMocks(tradeCount = 15) {
  ssmMock.on(GetParameterCommand).resolves({
    Parameter: { Value: 'test-api-key-123' },
  });

  vi.mocked(aggregateDailyRecords).mockReturnValue(mockAggregatedStats as any);

  // SQS queue depth — default low
  sqsMock.on(GetQueueAttributesCommand).resolves({
    Attributes: { ApproximateNumberOfMessages: '5' },
  });

  // Trade GSI query returns trade keys
  const trades = makeSampleTrades(tradeCount);
  ddbMock.on(QueryCommand, { TableName: 'test-trades' }).resolves({
    Items: trades.map(t => ({ userId: t.userId, tradeId: t.tradeId, openDate: t.openDate })),
    LastEvaluatedKey: undefined,
  });

  // BatchGet returns full trade records
  ddbMock.on(BatchGetCommand).resolves({
    Responses: { 'test-trades': trades },
    UnprocessedKeys: {},
  });

  // Daily stats query
  ddbMock.on(QueryCommand, { TableName: 'test-daily-stats' }).resolves({
    Items: [{ userId: 'user-1', date: '2026-04-01', totalPnl: 100 }],
    LastEvaluatedKey: undefined,
  });

  // Cache write succeeds
  ddbMock.on(PutCommand).resolves({});
}

// ---- Tests ----

beforeEach(() => {
  ddbMock.reset();
  ssmMock.reset();
  sqsMock.reset();
  fetchMock.mockReset();
  vi.mocked(aggregateDailyRecords).mockReset();
  setupDefaultMocks();
});

describe('refresh-insights-job handler', () => {
  // 1. Processes SQS batch and writes fresh cache entries
  describe('SQS batch processing', () => {
    it('processes SQS batch and writes fresh cache entries', async () => {
      mockGeminiSuccess();

      const event = makeSQSEvent([
        { userId: 'user-1', cacheKey: 'all#2026-04-01#2026-04-15' },
      ]);

      await handler(event, {} as any, () => {});

      // Verify cache write happened
      const putCalls = ddbMock.commandCalls(PutCommand);
      const cachePut = putCalls.find(c => c.args[0].input.TableName === 'test-insights-cache');
      expect(cachePut).toBeDefined();

      const item = cachePut!.args[0].input.Item as any;
      expect(item.userId).toBe('user-1');
      expect(item.cacheKey).toBe('all#2026-04-01#2026-04-15');
      expect(item.stale).toBe(false);
      expect(typeof item.ttl).toBe('number');

      // Verify the cached response contains patterns merged in
      const cachedData = JSON.parse(item.response);
      expect(cachedData.profile.type).toBe('day_trader');
      expect(cachedData.patterns).toBeDefined();
      expect(cachedData.patterns.tradeCount).toBe(15);
    });

    it('processes multiple distinct records in parallel', async () => {
      mockGeminiSuccess();
      mockGeminiSuccess();

      const event = makeSQSEvent([
        { userId: 'user-1', cacheKey: 'all#2026-04-01#2026-04-15' },
        { userId: 'user-2', cacheKey: 'all#2026-04-01#2026-04-15' },
      ]);

      await handler(event, {} as any, () => {});

      // Both should trigger Gemini calls
      expect(fetchMock).toHaveBeenCalledTimes(2);

      // Both should write to cache
      const putCalls = ddbMock.commandCalls(PutCommand);
      const cachePuts = putCalls.filter(c => c.args[0].input.TableName === 'test-insights-cache');
      expect(cachePuts.length).toBe(2);
    });
  });

  // 2. Deduplicates messages
  describe('deduplication', () => {
    it('deduplicates messages with same userId+cacheKey', async () => {
      mockGeminiSuccess();

      const event = makeSQSEvent([
        { userId: 'user-1', cacheKey: 'all#2026-04-01#2026-04-15' },
        { userId: 'user-1', cacheKey: 'all#2026-04-01#2026-04-15' },
        { userId: 'user-1', cacheKey: 'all#2026-04-01#2026-04-15' },
      ]);

      await handler(event, {} as any, () => {});

      // Only 1 Gemini call despite 3 identical messages
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('skips messages with missing userId or cacheKey', async () => {
      const event: SQSEvent = {
        Records: [
          {
            messageId: 'msg-0',
            receiptHandle: 'handle-0',
            body: JSON.stringify({ userId: 'user-1' }), // missing cacheKey
            attributes: {} as any,
            messageAttributes: {},
            md5OfBody: '',
            eventSource: 'aws:sqs',
            eventSourceARN: 'arn:aws:sqs:us-east-1:123456:test-queue',
            awsRegion: 'us-east-1',
          },
          {
            messageId: 'msg-1',
            receiptHandle: 'handle-1',
            body: JSON.stringify({ cacheKey: 'all#2026-04-01#2026-04-15' }), // missing userId
            attributes: {} as any,
            messageAttributes: {},
            md5OfBody: '',
            eventSource: 'aws:sqs',
            eventSourceARN: 'arn:aws:sqs:us-east-1:123456:test-queue',
            awsRegion: 'us-east-1',
          },
        ],
      };

      await handler(event, {} as any, () => {});

      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('skips unparseable SQS message bodies', async () => {
      const event: SQSEvent = {
        Records: [
          {
            messageId: 'msg-0',
            receiptHandle: 'handle-0',
            body: 'not-valid-json',
            attributes: {} as any,
            messageAttributes: {},
            md5OfBody: '',
            eventSource: 'aws:sqs',
            eventSourceARN: 'arn:aws:sqs:us-east-1:123456:test-queue',
            awsRegion: 'us-east-1',
          },
        ],
      };

      await handler(event, {} as any, () => {});

      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('returns early when all messages are invalid (unique map is empty)', async () => {
      const event: SQSEvent = {
        Records: [
          {
            messageId: 'msg-0',
            receiptHandle: 'handle-0',
            body: JSON.stringify({}), // no userId, no cacheKey
            attributes: {} as any,
            messageAttributes: {},
            md5OfBody: '',
            eventSource: 'aws:sqs',
            eventSourceARN: 'arn:aws:sqs:us-east-1:123456:test-queue',
            awsRegion: 'us-east-1',
          },
        ],
      };

      await handler(event, {} as any, () => {});

      // Should not call Gemini or SQS GetQueueAttributes
      expect(fetchMock).not.toHaveBeenCalled();
      expect(sqsMock.commandCalls(GetQueueAttributesCommand).length).toBe(0);
    });
  });

  // 3. Skips entries with fewer than MIN_TRADES_THRESHOLD trades
  describe('minimum trade threshold', () => {
    it('skips entries with fewer than MIN_TRADES_THRESHOLD trades', async () => {
      ddbMock.reset();
      ssmMock.reset();
      sqsMock.reset();
      fetchMock.mockReset();
      vi.mocked(aggregateDailyRecords).mockReset();
      setupDefaultMocks(5);

      const event = makeSQSEvent([
        { userId: 'user-1', cacheKey: 'all#2026-04-01#2026-04-15' },
      ]);

      await handler(event, {} as any, () => {});

      // Should NOT call Gemini
      expect(fetchMock).not.toHaveBeenCalled();

      // Should NOT write to cache
      const putCalls = ddbMock.commandCalls(PutCommand);
      const cachePuts = putCalls.filter(c => c.args[0].input.TableName === 'test-insights-cache');
      expect(cachePuts.length).toBe(0);
    });

    it('skips entries with zero trades', async () => {
      ddbMock.reset();
      ssmMock.reset();
      sqsMock.reset();
      fetchMock.mockReset();
      vi.mocked(aggregateDailyRecords).mockReset();
      setupDefaultMocks(0);

      ddbMock.on(QueryCommand, { TableName: 'test-trades' }).resolves({
        Items: [],
        LastEvaluatedKey: undefined,
      });

      const event = makeSQSEvent([
        { userId: 'user-1', cacheKey: 'all#2026-04-01#2026-04-15' },
      ]);

      await handler(event, {} as any, () => {});

      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  // 4. Handles Gemini failures gracefully
  describe('Gemini failure handling', () => {
    it('does not throw when Gemini call fails', async () => {
      fetchMock.mockRejectedValueOnce(new Error('Gemini API error: 500 Internal Server Error'));

      const event = makeSQSEvent([
        { userId: 'user-1', cacheKey: 'all#2026-04-01#2026-04-15' },
      ]);

      // Should not throw — graceful handling via Promise.allSettled
      await expect(handler(event, {} as any, () => {})).resolves.not.toThrow();
    });

    it('processes remaining records even if one fails', async () => {
      // First call fails, second succeeds
      fetchMock.mockRejectedValueOnce(new Error('Gemini API error'));
      mockGeminiSuccess();

      const event = makeSQSEvent([
        { userId: 'user-1', cacheKey: 'all#2026-04-01#2026-04-15' },
        { userId: 'user-2', cacheKey: 'all#2026-04-01#2026-04-15' },
      ]);

      await handler(event, {} as any, () => {});

      // Second record should still have written to cache
      const putCalls = ddbMock.commandCalls(PutCommand);
      const cachePuts = putCalls.filter(c => c.args[0].input.TableName === 'test-insights-cache');
      expect(cachePuts.length).toBe(1);
      expect(cachePuts[0].args[0].input.Item!.userId).toBe('user-2');
    });
  });

  // 5. Handles invalid JSON from Gemini
  describe('invalid JSON from Gemini', () => {
    it('skips cache write when Gemini returns non-JSON', async () => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          candidates: [{ content: { parts: [{ text: 'This is plain text, not JSON' }] } }],
        }),
      });

      const event = makeSQSEvent([
        { userId: 'user-1', cacheKey: 'all#2026-04-01#2026-04-15' },
      ]);

      await handler(event, {} as any, () => {});

      const putCalls = ddbMock.commandCalls(PutCommand);
      const cachePuts = putCalls.filter(c => c.args[0].input.TableName === 'test-insights-cache');
      expect(cachePuts.length).toBe(0);
    });

    it('skips cache write when Gemini returns malformed JSON', async () => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          candidates: [{ content: { parts: [{ text: '{"profile": {"type": broken' }] } }],
        }),
      });

      const event = makeSQSEvent([
        { userId: 'user-1', cacheKey: 'all#2026-04-01#2026-04-15' },
      ]);

      await handler(event, {} as any, () => {});

      const putCalls = ddbMock.commandCalls(PutCommand);
      const cachePuts = putCalls.filter(c => c.args[0].input.TableName === 'test-insights-cache');
      expect(cachePuts.length).toBe(0);
    });

    it('skips cache write when response fails schema validation', async () => {
      const invalidResponse = {
        profile: {
          type: 'unknown_type',
          aggressivenessScore: 5,
          summary: 'Test',
        },
        scores: [{ dimension: 'discipline', value: 50 }],
        insights: [],
        tradeSpotlights: [],
        summary: 'Test',
      };
      mockGeminiSuccess(invalidResponse);

      const event = makeSQSEvent([
        { userId: 'user-1', cacheKey: 'all#2026-04-01#2026-04-15' },
      ]);

      await handler(event, {} as any, () => {});

      const putCalls = ddbMock.commandCalls(PutCommand);
      const cachePuts = putCalls.filter(c => c.args[0].input.TableName === 'test-insights-cache');
      expect(cachePuts.length).toBe(0);
    });
  });

  // 6. Normalizes 'all' accountId to undefined
  describe('accountId normalization', () => {
    it('normalizes "all" accountId to undefined (no account filter)', async () => {
      mockGeminiSuccess();

      const event = makeSQSEvent([
        { userId: 'user-1', cacheKey: 'all#2026-04-01#2026-04-15' },
      ]);

      await handler(event, {} as any, () => {});

      // Verify the stats query used all-accounts pattern (GSI)
      const queryCalls = ddbMock.commandCalls(QueryCommand);
      const statsQuery = queryCalls.find(c => c.args[0].input.TableName === 'test-daily-stats');
      expect(statsQuery).toBeDefined();
      expect(statsQuery!.args[0].input.IndexName).toBe('stats-by-date-gsi');
    });

    it('passes specific accountId when not "all"', async () => {
      const trades = makeSampleTrades(15).map(t => ({ ...t, accountId: 'acc-42' }));
      ddbMock.on(QueryCommand, { TableName: 'test-trades' }).resolves({
        Items: trades.map(t => ({ userId: t.userId, tradeId: t.tradeId, openDate: t.openDate })),
        LastEvaluatedKey: undefined,
      });
      ddbMock.on(BatchGetCommand).resolves({
        Responses: { 'test-trades': trades },
        UnprocessedKeys: {},
      });
      mockGeminiSuccess();

      const event = makeSQSEvent([
        { userId: 'user-1', cacheKey: 'acc-42#2026-04-01#2026-04-15' },
      ]);

      await handler(event, {} as any, () => {});

      // Single-account stats query uses SK-based query (not GSI)
      const queryCalls = ddbMock.commandCalls(QueryCommand);
      const statsQuery = queryCalls.find(
        c => c.args[0].input.TableName === 'test-daily-stats' && !c.args[0].input.IndexName
      );
      expect(statsQuery).toBeDefined();
    });
  });

  // 7 & 8. Adaptive throttling
  describe('adaptive throttling', () => {
    it('enters throttle path when queue depth is below 100 (MIN_BATCH_DURATION_MS=0 so no actual wait)', async () => {
      mockGeminiSuccess();
      sqsMock.on(GetQueueAttributesCommand).resolves({
        Attributes: { ApproximateNumberOfMessages: '10' },
      });

      const event = makeSQSEvent([
        { userId: 'user-1', cacheKey: 'all#2026-04-01#2026-04-15' },
      ]);

      // With MIN_BATCH_DURATION_MS=0, elapsed will always be >= 0 so no sleep happens.
      // We verify the queue depth check was performed and it didn't go into burst mode.
      const consoleSpy = vi.spyOn(console, 'log');

      await handler(event, {} as any, () => {});

      // Should have checked queue depth
      expect(sqsMock.commandCalls(GetQueueAttributesCommand).length).toBe(1);

      // Should NOT log burst mode
      const burstLogs = consoleSpy.mock.calls.filter(
        call => typeof call[0] === 'string' && call[0].includes('Burst mode')
      );
      expect(burstLogs.length).toBe(0);

      consoleSpy.mockRestore();
    });

    it('enters burst mode when queue depth >= 100', async () => {
      mockGeminiSuccess();
      sqsMock.on(GetQueueAttributesCommand).resolves({
        Attributes: { ApproximateNumberOfMessages: '200' },
      });

      const event = makeSQSEvent([
        { userId: 'user-1', cacheKey: 'all#2026-04-01#2026-04-15' },
      ]);

      const consoleSpy = vi.spyOn(console, 'log');

      await handler(event, {} as any, () => {});

      // Should log burst mode
      const burstLogs = consoleSpy.mock.calls.filter(
        call => typeof call[0] === 'string' && call[0].includes('Burst mode')
      );
      expect(burstLogs.length).toBe(1);
      expect(burstLogs[0][0]).toContain('queue depth 200');

      consoleSpy.mockRestore();
    });

    it('checks queue depth via SQS GetQueueAttributes', async () => {
      mockGeminiSuccess();

      const event = makeSQSEvent([
        { userId: 'user-1', cacheKey: 'all#2026-04-01#2026-04-15' },
      ]);

      await handler(event, {} as any, () => {});

      expect(sqsMock.commandCalls(GetQueueAttributesCommand).length).toBe(1);
      const call = sqsMock.commandCalls(GetQueueAttributesCommand)[0];
      expect(call.args[0].input.QueueUrl).toBe('https://sqs.us-east-1.amazonaws.com/123456/test-queue');
      expect(call.args[0].input.AttributeNames).toContain('ApproximateNumberOfMessages');
    });

    it('defaults to queue depth 0 when GetQueueAttributes fails', async () => {
      mockGeminiSuccess();
      sqsMock.on(GetQueueAttributesCommand).rejects(new Error('SQS access denied'));

      const event = makeSQSEvent([
        { userId: 'user-1', cacheKey: 'all#2026-04-01#2026-04-15' },
      ]);

      // Should still complete without throwing
      await expect(handler(event, {} as any, () => {})).resolves.not.toThrow();
    });
  });

  // Merged patterns
  describe('patterns merged into cache entry', () => {
    it('includes detectPatterns result in the cached response', async () => {
      mockGeminiSuccess();

      const event = makeSQSEvent([
        { userId: 'user-1', cacheKey: 'all#2026-04-01#2026-04-15' },
      ]);

      await handler(event, {} as any, () => {});

      const putCalls = ddbMock.commandCalls(PutCommand);
      const cachePut = putCalls.find(c => c.args[0].input.TableName === 'test-insights-cache');
      expect(cachePut).toBeDefined();

      const cachedData = JSON.parse(cachePut!.args[0].input.Item!.response as string);
      expect(cachedData.patterns).toBeDefined();
      expect(cachedData.patterns.costOfEmotion).toBeDefined();
      expect(Array.isArray(cachedData.patterns.hourlyEdges)).toBe(true);
      expect(Array.isArray(cachedData.patterns.dayOfWeekEdges)).toBe(true);
    });
  });

  describe('generatedAt in cache entry', () => {
    it('writes generatedAt as ISO string to cache', async () => {
      mockGeminiSuccess();

      const event = makeSQSEvent([
        { userId: 'user-1', cacheKey: 'all#2026-04-01#2026-04-15' },
      ]);

      await handler(event, {} as any, () => {});

      const putCalls = ddbMock.commandCalls(PutCommand);
      const cachePut = putCalls.find(c => c.args[0].input.TableName === 'test-insights-cache');
      expect(cachePut).toBeDefined();

      const item = cachePut!.args[0].input.Item as any;
      expect(item.generatedAt).toBeDefined();
      expect(new Date(item.generatedAt).toISOString()).toBe(item.generatedAt);
    });
  });
});
