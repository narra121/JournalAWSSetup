import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import 'aws-sdk-client-mock-jest';
import {
  DynamoDBDocumentClient,
  GetCommand,
  QueryCommand,
  BatchGetCommand,
} from '@aws-sdk/lib-dynamodb';
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';
import type { APIGatewayProxyEventV2 } from 'aws-lambda';

// Stub env BEFORE importing handler
vi.stubEnv('TRADES_TABLE', 'test-trades');
vi.stubEnv('DAILY_STATS_TABLE', 'test-daily-stats');
vi.stubEnv('SUBSCRIPTIONS_TABLE', 'test-subscriptions');
vi.stubEnv('GEMINI_API_KEY_PARAM', '/test/gemini-key');
vi.stubEnv('GEMINI_REQUEST_TIMEOUT_MS', '5000');
vi.stubEnv('STAGE', 'test');

// Mock DynamoDB and SSM
const ddbMock = mockClient(DynamoDBDocumentClient);
const ssmMock = mockClient(SSMClient);

// Mock global fetch
const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

// Mock subscription module
vi.mock('../../../shared/subscription', () => ({
  getSubscriptionTier: vi.fn(),
}));

// Mock stats aggregator
vi.mock('../../../shared/stats-aggregator', () => ({
  aggregateDailyRecords: vi.fn(),
}));

const { handler } = await import('../app.ts');

// Import mock references after vi.mock so we get the mocked versions
const { getSubscriptionTier } = await import('../../../shared/subscription');
const { aggregateDailyRecords } = await import('../../../shared/stats-aggregator');

// ─── Helpers ────────────────────────────────────────────────────

function makeJwt(sub: string): string {
  const header = btoa(JSON.stringify({ alg: 'RS256' }));
  const payload = btoa(JSON.stringify({ sub }));
  return `${header}.${payload}.sig`;
}

function makeEvent(body?: any, overrides: Partial<APIGatewayProxyEventV2> = {}): APIGatewayProxyEventV2 {
  return {
    version: '2.0',
    routeKey: 'POST /v1/insights/chat',
    rawPath: '/v1/insights/chat',
    rawQueryString: '',
    headers: {
      authorization: `Bearer ${makeJwt('user-1')}`,
    },
    requestContext: {
      accountId: '123',
      apiId: 'api',
      domainName: 'api.example.com',
      domainPrefix: 'api',
      http: { method: 'POST', path: '/v1/insights/chat', protocol: 'HTTP/1.1', sourceIp: '127.0.0.1', userAgent: 'test' },
      requestId: 'req-1',
      routeKey: 'POST /v1/insights/chat',
      stage: '$default',
      time: '01/Jan/2024:00:00:00 +0000',
      timeEpoch: 0,
    },
    body: body !== undefined ? (typeof body === 'string' ? body : JSON.stringify(body)) : undefined,
    isBase64Encoded: false,
    ...overrides,
  } as unknown as APIGatewayProxyEventV2;
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
      openDate: `2026-04-${String(1 + (i % 28)).padStart(2, '0')}T10:00:00`,
      closeDate: `2026-04-${String(1 + (i % 28)).padStart(2, '0')}T11:00:00`,
      entryPrice: 1.1 + i * 0.001,
      exitPrice: 1.101 + i * 0.001,
      stopLoss: 1.099,
      takeProfit: 1.102,
      pnl: (i % 3 === 0) ? -(5 + i) : (10 + i),
      setupType: 'breakout',
      notes: 'Some trade notes',
    });
  }
  return trades;
}

const mockAggregatedStats = {
  totalTrades: 10,
  winCount: 6,
  lossCount: 4,
  winRate: 60,
  totalPnl: 100,
  avgPnl: 10,
  maxDrawdown: -20,
  profitFactor: 2.0,
};

function mockGeminiChatSuccess(text: string = 'Your win rate is 60% which is solid.\n\n<suggestions>["What is my best symbol?", "How can I improve?"]</suggestions>') {
  fetchMock.mockResolvedValueOnce({
    ok: true,
    json: async () => ({
      candidates: [{ content: { parts: [{ text }] } }],
    }),
  });
}

// ─── Default mock setup ────────────────────────────────────────

function setupDefaultMocks() {
  ssmMock.on(GetParameterCommand).resolves({
    Parameter: { Value: 'test-api-key-123' },
  });

  vi.mocked(getSubscriptionTier).mockResolvedValue({
    tier: 'paid',
    showAds: false,
    status: 'active',
  });

  vi.mocked(aggregateDailyRecords).mockReturnValue(mockAggregatedStats as any);

  // Trade GSI query returns trade keys
  const trades = makeSampleTrades(10);
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
}

// ─── Tests ──────────────────────────────────────────────────────

beforeEach(() => {
  ddbMock.reset();
  ssmMock.reset();
  fetchMock.mockReset();
  vi.mocked(getSubscriptionTier).mockReset();
  vi.mocked(aggregateDailyRecords).mockReset();
  setupDefaultMocks();
});

describe('insights-chat handler', () => {
  // ── Auth ──────────────────────────────────────────────────────

  describe('authentication', () => {
    it('returns 401 when no authorization header', async () => {
      const event = makeEvent(
        { message: 'How am I doing?', startDate: '2026-04-01', endDate: '2026-04-15' },
        { headers: {} },
      );

      const res = await handler(event, {} as any) as any;

      expect(res.statusCode).toBe(401);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(false);
      expect(body.errorCode).toBe('UNAUTHORIZED');
    });
  });

  // ── Subscription gate ────────────────────────────────────────

  describe('subscription gate', () => {
    it('returns 403 when user is on free tier', async () => {
      vi.mocked(getSubscriptionTier).mockResolvedValueOnce({
        tier: 'free_with_ads',
        showAds: true,
        status: 'none',
      });

      const res = await handler(
        makeEvent({ message: 'How am I doing?', startDate: '2026-04-01', endDate: '2026-04-15' }),
        {} as any,
      ) as any;

      expect(res.statusCode).toBe(403);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(false);
      expect(body.errorCode).toBe('SUBSCRIPTION_REQUIRED');
      expect(body.message).toContain('premium subscription');
    });
  });

  // ── Request validation ───────────────────────────────────────

  describe('request validation', () => {
    it('returns 400 when body is missing', async () => {
      const event = makeEvent(undefined);
      event.body = undefined;

      const res = await handler(event, {} as any) as any;

      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(false);
      expect(body.errorCode).toBe('VALIDATION_ERROR');
      expect(body.message).toContain('Missing request body');
    });

    it('returns 400 when body is invalid JSON', async () => {
      const res = await handler(makeEvent('{not-json'), {} as any) as any;

      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(false);
      expect(body.errorCode).toBe('VALIDATION_ERROR');
      expect(body.message).toContain('Invalid JSON');
    });

    it('returns 400 when message is missing', async () => {
      const res = await handler(
        makeEvent({ startDate: '2026-04-01', endDate: '2026-04-15' }),
        {} as any,
      ) as any;

      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(false);
      expect(body.errorCode).toBe('VALIDATION_ERROR');
      expect(body.message).toContain('message, startDate, and endDate are required');
    });

    it('returns 400 when startDate is missing', async () => {
      const res = await handler(
        makeEvent({ message: 'How am I doing?', endDate: '2026-04-15' }),
        {} as any,
      ) as any;

      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(false);
      expect(body.errorCode).toBe('VALIDATION_ERROR');
      expect(body.message).toContain('message, startDate, and endDate are required');
    });

    it('returns 400 when endDate is missing', async () => {
      const res = await handler(
        makeEvent({ message: 'How am I doing?', startDate: '2026-04-01' }),
        {} as any,
      ) as any;

      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(false);
      expect(body.errorCode).toBe('VALIDATION_ERROR');
      expect(body.message).toContain('message, startDate, and endDate are required');
    });
  });

  // ── Successful chat response ─────────────────────────────────

  describe('successful chat response', () => {
    it('returns successful chat response with reply', async () => {
      mockGeminiChatSuccess();

      const res = await handler(
        makeEvent({ message: 'What is my win rate?', startDate: '2026-04-01', endDate: '2026-04-15' }),
        {} as any,
      ) as any;

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(true);
      expect(body.message).toBe('Chat response generated');
      expect(body.data.reply).toBeDefined();
      expect(typeof body.data.reply).toBe('string');
      expect(body.data.reply.length).toBeGreaterThan(0);
    });

    it('extracts suggestedQuestions from response', async () => {
      mockGeminiChatSuccess('Your win rate is 60%.\n\n<suggestions>["What is my best symbol?", "How can I improve?"]</suggestions>');

      const res = await handler(
        makeEvent({ message: 'What is my win rate?', startDate: '2026-04-01', endDate: '2026-04-15' }),
        {} as any,
      ) as any;

      const body = JSON.parse(res.body);
      expect(body.data.suggestedQuestions).toEqual(['What is my best symbol?', 'How can I improve?']);
      // Reply should not contain the suggestions tag
      expect(body.data.reply).not.toContain('<suggestions>');
      expect(body.data.reply).not.toContain('</suggestions>');
      expect(body.data.reply).toContain('Your win rate is 60%');
    });

    it('returns reply without suggestedQuestions when none present', async () => {
      mockGeminiChatSuccess('Your trading shows a balanced approach with a 60% win rate.');

      const res = await handler(
        makeEvent({ message: 'How am I doing?', startDate: '2026-04-01', endDate: '2026-04-15' }),
        {} as any,
      ) as any;

      const body = JSON.parse(res.body);
      expect(body.data.reply).toBe('Your trading shows a balanced approach with a 60% win rate.');
      expect(body.data.suggestedQuestions).toBeUndefined();
    });

    it('calls Gemini with correct URL and API key', async () => {
      mockGeminiChatSuccess();

      await handler(
        makeEvent({ message: 'What is my win rate?', startDate: '2026-04-01', endDate: '2026-04-15' }),
        {} as any,
      );

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, options] = fetchMock.mock.calls[0];
      expect(url).toContain('generativelanguage.googleapis.com');
      expect(url).toContain('gemini-2.5-flash');
      expect(url).toContain('generateContent');
      expect(options.headers['x-goog-api-key']).toBe('test-api-key-123');
      expect(options.method).toBe('POST');
    });

    it('includes trade context in prompt sent to Gemini', async () => {
      mockGeminiChatSuccess();

      await handler(
        makeEvent({ message: 'What is my win rate?', startDate: '2026-04-01', endDate: '2026-04-15' }),
        {} as any,
      );

      const [, options] = fetchMock.mock.calls[0];
      const requestBody = JSON.parse(options.body);
      const promptText = requestBody.contents[0].parts[0].text;

      expect(promptText).toContain('Total trades: 10');
      expect(promptText).toContain('Top symbols');
      expect(promptText).toContain('Best 5 trades');
      expect(promptText).toContain('Worst 5 trades');
      expect(promptText).toContain('2026-04-01');
      expect(promptText).toContain('2026-04-15');
    });

    it('includes user message in prompt sent to Gemini', async () => {
      mockGeminiChatSuccess();

      await handler(
        makeEvent({ message: 'What is my best performing symbol?', startDate: '2026-04-01', endDate: '2026-04-15' }),
        {} as any,
      );

      const [, options] = fetchMock.mock.calls[0];
      const requestBody = JSON.parse(options.body);
      const promptText = requestBody.contents[0].parts[0].text;

      expect(promptText).toContain('What is my best performing symbol?');
    });
  });

  // ── Account ID handling ──────────────────────────────────────

  describe('accountId handling', () => {
    it('normalizes accountId ALL to undefined (no account filter)', async () => {
      mockGeminiChatSuccess();

      const res = await handler(
        makeEvent({ message: 'How am I doing?', accountId: 'ALL', startDate: '2026-04-01', endDate: '2026-04-15' }),
        {} as any,
      ) as any;

      expect(res.statusCode).toBe(200);

      // Verify trades were queried — the QueryCommand for the GSI should be called
      // but NOT with an accountId filter expression
      const queryCalls = ddbMock.commandCalls(QueryCommand);
      const tradesQuery = queryCalls.find(c => c.args[0].input.TableName === 'test-trades');
      expect(tradesQuery).toBeDefined();

      // DailyStats should query the all-accounts GSI path (no accountId in SK)
      const statsQuery = queryCalls.find(c => c.args[0].input.TableName === 'test-daily-stats');
      expect(statsQuery).toBeDefined();
      // All-accounts query uses the GSI, not SK-based prefix
      expect(statsQuery!.args[0].input.IndexName).toBe('stats-by-date-gsi');
    });

    it('passes specific accountId to fetch functions', async () => {
      const tradesWithAccount = makeSampleTrades(10).map(t => ({ ...t, accountId: 'acc-1' }));
      ddbMock.on(QueryCommand, { TableName: 'test-trades' }).resolves({
        Items: tradesWithAccount.map(t => ({ userId: t.userId, tradeId: t.tradeId, openDate: t.openDate })),
        LastEvaluatedKey: undefined,
      });
      ddbMock.on(BatchGetCommand).resolves({
        Responses: { 'test-trades': tradesWithAccount },
        UnprocessedKeys: {},
      });
      // Stats for single account uses SK prefix query (no IndexName)
      ddbMock.on(QueryCommand, { TableName: 'test-daily-stats' }).resolves({
        Items: [{ userId: 'user-1', sk: 'acc-1#2026-04-01', date: '2026-04-01', totalPnl: 50 }],
        LastEvaluatedKey: undefined,
      });
      mockGeminiChatSuccess();

      const res = await handler(
        makeEvent({ message: 'How am I doing?', accountId: 'acc-1', startDate: '2026-04-01', endDate: '2026-04-15' }),
        {} as any,
      ) as any;

      expect(res.statusCode).toBe(200);
    });
  });

  // ── Conversation history ─────────────────────────────────────

  describe('conversation history', () => {
    it('includes conversation history in prompt', async () => {
      mockGeminiChatSuccess();

      const history = [
        { role: 'user', content: 'What is my win rate?' },
        { role: 'assistant', content: 'Your win rate is 60%.' },
      ];

      await handler(
        makeEvent({ message: 'How about for EURUSD only?', startDate: '2026-04-01', endDate: '2026-04-15', history }),
        {} as any,
      );

      const [, options] = fetchMock.mock.calls[0];
      const requestBody = JSON.parse(options.body);
      const promptText = requestBody.contents[0].parts[0].text;

      expect(promptText).toContain('user: What is my win rate?');
      expect(promptText).toContain('assistant: Your win rate is 60%.');
      expect(promptText).toContain('user: How about for EURUSD only?');
    });

    it('limits conversation history to last 10 messages', async () => {
      mockGeminiChatSuccess();

      // Create 15 history messages
      const history = Array.from({ length: 15 }, (_, i) => ({
        role: i % 2 === 0 ? 'user' : 'assistant',
        content: `Message number ${i}`,
      }));

      await handler(
        makeEvent({ message: 'Latest question', startDate: '2026-04-01', endDate: '2026-04-15', history }),
        {} as any,
      );

      const [, options] = fetchMock.mock.calls[0];
      const requestBody = JSON.parse(options.body);
      const promptText = requestBody.contents[0].parts[0].text;

      // Messages 0-4 (first 5) should NOT be in the prompt — use word boundary regex
      expect(promptText).not.toMatch(/Message number 0\b/);
      expect(promptText).not.toMatch(/Message number 1\b/);
      expect(promptText).not.toMatch(/Message number 2\b/);
      expect(promptText).not.toMatch(/Message number 3\b/);
      expect(promptText).not.toMatch(/Message number 4\b/);

      // Messages 5-14 (last 10) should be in the prompt
      expect(promptText).toContain('Message number 5');
      expect(promptText).toContain('Message number 14');
      expect(promptText).toContain('Latest question');
    });

    it('handles empty history gracefully', async () => {
      mockGeminiChatSuccess();

      const res = await handler(
        makeEvent({ message: 'First question', startDate: '2026-04-01', endDate: '2026-04-15', history: [] }),
        {} as any,
      ) as any;

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(true);
    });

    it('handles missing history field gracefully', async () => {
      mockGeminiChatSuccess();

      const res = await handler(
        makeEvent({ message: 'First question', startDate: '2026-04-01', endDate: '2026-04-15' }),
        {} as any,
      ) as any;

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(true);
    });
  });

  // ── Gemini error handling ────────────────────────────────────

  describe('Gemini error handling', () => {
    it('returns 500 when Gemini API returns non-ok response', async () => {
      // Need to mock all 3 model attempts since callGemini iterates through MODELS
      fetchMock.mockResolvedValueOnce({
        ok: false,
        status: 429,
        statusText: 'Too Many Requests',
        text: async () => 'Rate limit exceeded',
      });
      fetchMock.mockResolvedValueOnce({
        ok: false,
        status: 429,
        statusText: 'Too Many Requests',
        text: async () => 'Rate limit exceeded',
      });
      fetchMock.mockResolvedValueOnce({
        ok: false,
        status: 500,
        statusText: 'Internal Server Error',
        text: async () => 'Server error',
      });

      const res = await handler(
        makeEvent({ message: 'How am I doing?', startDate: '2026-04-01', endDate: '2026-04-15' }),
        {} as any,
      ) as any;

      expect(res.statusCode).toBe(500);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(false);
      expect(body.errorCode).toBe('INTERNAL_ERROR');
    });

    it('returns 500 when fetch throws network error', async () => {
      fetchMock.mockRejectedValueOnce(new Error('Network failure'));

      const res = await handler(
        makeEvent({ message: 'How am I doing?', startDate: '2026-04-01', endDate: '2026-04-15' }),
        {} as any,
      ) as any;

      expect(res.statusCode).toBe(500);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(false);
      expect(body.errorCode).toBe('INTERNAL_ERROR');
    });

    it('returns 500 when Gemini returns empty candidates', async () => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ candidates: [{ content: { parts: [{}] } }] }),
      });

      const res = await handler(
        makeEvent({ message: 'How am I doing?', startDate: '2026-04-01', endDate: '2026-04-15' }),
        {} as any,
      ) as any;

      expect(res.statusCode).toBe(500);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(false);
      expect(body.errorCode).toBe('INTERNAL_ERROR');
    });
  });

  // ── Suggestions parsing edge cases ───────────────────────────

  describe('suggestions parsing edge cases', () => {
    it('handles malformed JSON in suggestions tags gracefully', async () => {
      mockGeminiChatSuccess('Your win rate is great.\n\n<suggestions>[not valid json</suggestions>');

      const res = await handler(
        makeEvent({ message: 'How am I doing?', startDate: '2026-04-01', endDate: '2026-04-15' }),
        {} as any,
      ) as any;

      const body = JSON.parse(res.body);
      expect(res.statusCode).toBe(200);
      // suggestedQuestions should be undefined since JSON parse failed
      expect(body.data.suggestedQuestions).toBeUndefined();
      // The reply should still contain the raw text (suggestions not stripped on parse failure)
      expect(body.data.reply).toContain('Your win rate is great');
    });

    it('handles suggestions with three questions', async () => {
      mockGeminiChatSuccess('Analysis complete.\n\n<suggestions>["Q1?", "Q2?", "Q3?"]</suggestions>');

      const res = await handler(
        makeEvent({ message: 'Analyze me', startDate: '2026-04-01', endDate: '2026-04-15' }),
        {} as any,
      ) as any;

      const body = JSON.parse(res.body);
      expect(body.data.suggestedQuestions).toEqual(['Q1?', 'Q2?', 'Q3?']);
      expect(body.data.reply).toBe('Analysis complete.');
    });
  });
});
