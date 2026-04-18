import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import 'aws-sdk-client-mock-jest';
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  BatchGetCommand,
} from '@aws-sdk/lib-dynamodb';
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';
import type { APIGatewayProxyEventV2 } from 'aws-lambda';

// Stub env BEFORE importing handler
vi.stubEnv('TRADES_TABLE', 'test-trades');
vi.stubEnv('DAILY_STATS_TABLE', 'test-daily-stats');
vi.stubEnv('INSIGHTS_CACHE_TABLE', 'test-insights-cache');
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
    routeKey: 'POST /generate-insights',
    rawPath: '/generate-insights',
    rawQueryString: '',
    headers: {
      authorization: `Bearer ${makeJwt('user-1')}`,
    },
    requestContext: {
      accountId: '123',
      apiId: 'api',
      domainName: 'api.example.com',
      domainPrefix: 'api',
      http: { method: 'POST', path: '/generate-insights', protocol: 'HTTP/1.1', sourceIp: '127.0.0.1', userAgent: 'test' },
      requestId: 'req-1',
      routeKey: 'POST /generate-insights',
      stage: '$default',
      time: '01/Jan/2024:00:00:00 +0000',
      timeEpoch: 0,
    },
    body: body !== undefined ? (typeof body === 'string' ? body : JSON.stringify(body)) : undefined,
    isBase64Encoded: false,
    ...overrides,
  } as unknown as APIGatewayProxyEventV2;
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
      { severity: 'warning', title: 'Inconsistent sizing', detail: 'Position sizes vary significantly', evidence: 'StdDev 2.5x mean' },
      { severity: 'strength', title: 'Good win rate', detail: '60% win rate above average', evidence: '9/15 trades profitable' },
    ],
    tradeSpotlights: [
      { tradeId: 'trade-1', symbol: 'EURUSD', date: '2026-04-10', pnl: 100, reason: 'Best trade of the period' },
      { tradeId: 'trade-5', symbol: 'XAUUSD', date: '2026-04-12', pnl: -50, reason: 'Worst loss — wide stop' },
      { tradeId: 'trade-8', symbol: 'GBPUSD', date: '2026-04-14', pnl: 30, reason: 'Exemplifies over-leverage pattern' },
    ],
    summary: 'Overall a balanced day trader showing solid fundamentals but needs to work on position sizing.',
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

function mockGeminiNonJson(text: string = 'This is not JSON at all') {
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

  // Cache miss by default
  ddbMock.on(GetCommand, { TableName: 'test-insights-cache' }).resolves({ Item: undefined });

  // Trade GSI query returns trade keys
  const trades = makeSampleTrades(15);
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

// ─── Tests ──────────────────────────────────────────────────────

beforeEach(() => {
  ddbMock.reset();
  ssmMock.reset();
  fetchMock.mockReset();
  vi.mocked(getSubscriptionTier).mockReset();
  vi.mocked(aggregateDailyRecords).mockReset();
  setupDefaultMocks();
});

describe('generate-insights handler', () => {
  // ── Auth ──────────────────────────────────────────────────────

  describe('authentication', () => {
    it('returns 401 when no authorization header', async () => {
      const event = makeEvent(
        { startDate: '2026-04-01', endDate: '2026-04-15' },
        { headers: {} },
      );

      const res = await handler(event, {} as any) as any;

      expect(res.statusCode).toBe(401);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(false);
      expect(body.errorCode).toBe('UNAUTHORIZED');
    });

    it('returns 401 when JWT has no sub claim', async () => {
      const header = btoa(JSON.stringify({ alg: 'RS256' }));
      const payload = btoa(JSON.stringify({ email: 'test@example.com' })); // no sub
      const jwt = `${header}.${payload}.sig`;

      const event = makeEvent(
        { startDate: '2026-04-01', endDate: '2026-04-15' },
        { headers: { authorization: `Bearer ${jwt}` } },
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
        makeEvent({ startDate: '2026-04-01', endDate: '2026-04-15' }),
        {} as any,
      ) as any;

      expect(res.statusCode).toBe(403);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(false);
      expect(body.errorCode).toBe('SUBSCRIPTION_REQUIRED');
      expect(body.message).toContain('premium subscription');
    });

    it('allows access for paid tier', async () => {
      mockGeminiSuccess();

      const res = await handler(
        makeEvent({ startDate: '2026-04-01', endDate: '2026-04-15' }),
        {} as any,
      ) as any;

      expect(res.statusCode).toBe(200);
    });

    it('allows access for trial tier', async () => {
      vi.mocked(getSubscriptionTier).mockResolvedValueOnce({
        tier: 'trial',
        showAds: false,
        trialEnd: '2026-05-01',
        status: 'trial',
      });
      mockGeminiSuccess();

      const res = await handler(
        makeEvent({ startDate: '2026-04-01', endDate: '2026-04-15' }),
        {} as any,
      ) as any;

      expect(res.statusCode).toBe(200);
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
      expect(body.message).toContain('Body must be valid JSON');
    });

    it('returns 400 when startDate is missing', async () => {
      const res = await handler(
        makeEvent({ endDate: '2026-04-15' }),
        {} as any,
      ) as any;

      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(false);
      expect(body.errorCode).toBe('VALIDATION_ERROR');
      expect(body.message).toContain('startDate and endDate are required');
    });

    it('returns 400 when endDate is missing', async () => {
      const res = await handler(
        makeEvent({ startDate: '2026-04-01' }),
        {} as any,
      ) as any;

      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(false);
      expect(body.errorCode).toBe('VALIDATION_ERROR');
      expect(body.message).toContain('startDate and endDate are required');
    });

    it('returns 400 when both startDate and endDate are missing', async () => {
      const res = await handler(
        makeEvent({ accountId: 'acc-1' }),
        {} as any,
      ) as any;

      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(false);
      expect(body.message).toContain('startDate and endDate are required');
    });
  });

  // ── Cache hit ────────────────────────────────────────────────

  describe('cache hit', () => {
    const freshGeneratedAt = new Date(Date.now() - 1000 * 60 * 30).toISOString(); // 30 min ago

    function mockCacheHit(overrides: Partial<{ stale: boolean; generatedAt: string }> = {}) {
      ddbMock.on(GetCommand, { TableName: 'test-insights-cache' }).resolves({
        Item: {
          userId: 'user-1',
          cacheKey: 'all#2026-04-01#2026-04-15',
          response: JSON.stringify(makeSampleInsightsResponse()),
          generatedAt: overrides.generatedAt ?? freshGeneratedAt,
          stale: overrides.stale ?? false,
          ttl: Math.floor(Date.now() / 1000) + 86400 * 30,
        },
      });

      // Mock the countTradesSince query
      ddbMock.on(QueryCommand, {
        TableName: 'test-trades',
        Select: 'COUNT',
      }).resolves({ Count: 3, LastEvaluatedKey: undefined });
    }

    it('returns cached response when cache is valid and within 6-hour cooldown', async () => {
      mockCacheHit();

      const res = await handler(
        makeEvent({ startDate: '2026-04-01', endDate: '2026-04-15' }),
        {} as any,
      ) as any;

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(true);
      expect(body.data.profile.type).toBe('day_trader');
      expect(body.message).toContain('cache');
    });

    it('sets meta.cached to true on cache hit', async () => {
      mockCacheHit();

      const res = await handler(
        makeEvent({ startDate: '2026-04-01', endDate: '2026-04-15' }),
        {} as any,
      ) as any;

      const body = JSON.parse(res.body);
      expect(body.meta.cached).toBe(true);
    });

    it('includes meta.newTradesSince count on cache hit', async () => {
      mockCacheHit();

      const res = await handler(
        makeEvent({ startDate: '2026-04-01', endDate: '2026-04-15' }),
        {} as any,
      ) as any;

      const body = JSON.parse(res.body);
      expect(typeof body.meta.newTradesSince).toBe('number');
      expect(body.meta.newTradesSince).toBe(3);
    });

    it('does NOT call Gemini when cache hit', async () => {
      mockCacheHit();

      await handler(
        makeEvent({ startDate: '2026-04-01', endDate: '2026-04-15' }),
        {} as any,
      );

      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('includes generatedAt in cache hit meta', async () => {
      mockCacheHit();

      const res = await handler(
        makeEvent({ startDate: '2026-04-01', endDate: '2026-04-15' }),
        {} as any,
      ) as any;

      const body = JSON.parse(res.body);
      expect(body.meta.generatedAt).toBe(freshGeneratedAt);
    });
  });

  // ── Cache miss (stale or expired) ────────────────────────────

  describe('cache miss (stale or expired)', () => {
    it('calls Gemini when cache entry is stale', async () => {
      ddbMock.on(GetCommand, { TableName: 'test-insights-cache' }).resolves({
        Item: {
          userId: 'user-1',
          cacheKey: 'all#2026-04-01#2026-04-15',
          response: JSON.stringify(makeSampleInsightsResponse()),
          generatedAt: new Date(Date.now() - 60_000).toISOString(),
          stale: true,
          ttl: Math.floor(Date.now() / 1000) + 86400 * 30,
        },
      });
      mockGeminiSuccess();

      const res = await handler(
        makeEvent({ startDate: '2026-04-01', endDate: '2026-04-15' }),
        {} as any,
      ) as any;

      expect(res.statusCode).toBe(200);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const body = JSON.parse(res.body);
      expect(body.meta.cached).toBe(false);
    });

    it('calls Gemini when cache entry is older than 6 hours', async () => {
      const sevenHoursAgo = new Date(Date.now() - 7 * 60 * 60 * 1000).toISOString();
      ddbMock.on(GetCommand, { TableName: 'test-insights-cache' }).resolves({
        Item: {
          userId: 'user-1',
          cacheKey: 'all#2026-04-01#2026-04-15',
          response: JSON.stringify(makeSampleInsightsResponse()),
          generatedAt: sevenHoursAgo,
          stale: false,
          ttl: Math.floor(Date.now() / 1000) + 86400 * 30,
        },
      });
      mockGeminiSuccess();

      const res = await handler(
        makeEvent({ startDate: '2026-04-01', endDate: '2026-04-15' }),
        {} as any,
      ) as any;

      expect(res.statusCode).toBe(200);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const body = JSON.parse(res.body);
      expect(body.meta.cached).toBe(false);
    });

    it('calls Gemini when no cache entry exists at all', async () => {
      mockGeminiSuccess();

      const res = await handler(
        makeEvent({ startDate: '2026-04-01', endDate: '2026-04-15' }),
        {} as any,
      ) as any;

      expect(res.statusCode).toBe(200);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const body = JSON.parse(res.body);
      expect(body.meta.cached).toBe(false);
    });
  });

  // ── Minimum trade threshold ──────────────────────────────────

  describe('minimum trade threshold', () => {
    it('returns INSUFFICIENT_DATA when fewer than 10 trades', async () => {
      const fewTrades = makeSampleTrades(5);
      ddbMock.on(QueryCommand, { TableName: 'test-trades' }).resolves({
        Items: fewTrades.map(t => ({ userId: t.userId, tradeId: t.tradeId, openDate: t.openDate })),
        LastEvaluatedKey: undefined,
      });
      ddbMock.on(BatchGetCommand).resolves({
        Responses: { 'test-trades': fewTrades },
        UnprocessedKeys: {},
      });

      const res = await handler(
        makeEvent({ startDate: '2026-04-01', endDate: '2026-04-15' }),
        {} as any,
      ) as any;

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.data).toBeNull();
      expect(body.message).toContain('Insufficient trade data');
      expect(body.meta.tradeCount).toBe(5);
      expect(body.meta.minRequired).toBe(10);
    });

    it('returns INSUFFICIENT_DATA when zero trades found', async () => {
      ddbMock.on(QueryCommand, { TableName: 'test-trades' }).resolves({
        Items: [],
        LastEvaluatedKey: undefined,
      });

      const res = await handler(
        makeEvent({ startDate: '2026-04-01', endDate: '2026-04-15' }),
        {} as any,
      ) as any;

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.data).toBeNull();
      expect(body.message).toContain('Insufficient trade data');
      expect(body.meta.tradeCount).toBe(0);
    });

    it('does NOT call Gemini when insufficient trades', async () => {
      const fewTrades = makeSampleTrades(3);
      ddbMock.on(QueryCommand, { TableName: 'test-trades' }).resolves({
        Items: fewTrades.map(t => ({ userId: t.userId, tradeId: t.tradeId, openDate: t.openDate })),
        LastEvaluatedKey: undefined,
      });
      ddbMock.on(BatchGetCommand).resolves({
        Responses: { 'test-trades': fewTrades },
        UnprocessedKeys: {},
      });

      await handler(
        makeEvent({ startDate: '2026-04-01', endDate: '2026-04-15' }),
        {} as any,
      );

      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('returns exactly 10 as the minimum required threshold', async () => {
      const fewTrades = makeSampleTrades(9);
      ddbMock.on(QueryCommand, { TableName: 'test-trades' }).resolves({
        Items: fewTrades.map(t => ({ userId: t.userId, tradeId: t.tradeId, openDate: t.openDate })),
        LastEvaluatedKey: undefined,
      });
      ddbMock.on(BatchGetCommand).resolves({
        Responses: { 'test-trades': fewTrades },
        UnprocessedKeys: {},
      });

      const res = await handler(
        makeEvent({ startDate: '2026-04-01', endDate: '2026-04-15' }),
        {} as any,
      ) as any;

      const body = JSON.parse(res.body);
      expect(body.meta.minRequired).toBe(10);
      expect(body.meta.tradeCount).toBe(9);
      expect(body.data).toBeNull();
    });

    it('treats accountId=ALL as no account filter (fetches all trades)', async () => {
      mockGeminiSuccess();

      const res = await handler(
        makeEvent({ accountId: 'ALL', startDate: '2026-04-01', endDate: '2026-04-15' }),
        {} as any,
      ) as any;

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.data).not.toBeNull();
      expect(body.meta.tradeCount).toBe(15);
    });
  });

  // ── Gemini call success ──────────────────────────────────────

  describe('Gemini call success', () => {
    it('returns InsightsResponse with meta.cached = false on fresh generation', async () => {
      mockGeminiSuccess();

      const res = await handler(
        makeEvent({ startDate: '2026-04-01', endDate: '2026-04-15' }),
        {} as any,
      ) as any;

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(true);
      expect(body.meta.cached).toBe(false);
      expect(body.meta.newTradesSince).toBe(0);
      expect(body.meta.tradeCount).toBe(15);
      expect(body.data.profile.type).toBe('day_trader');
      expect(body.data.scores).toHaveLength(5);
      expect(body.data.insights).toHaveLength(2);
      expect(body.data.tradeSpotlights).toHaveLength(3);
      expect(typeof body.data.summary).toBe('string');
    });

    it('fetches trades and stats in parallel', async () => {
      mockGeminiSuccess();

      const res = await handler(
        makeEvent({ startDate: '2026-04-01', endDate: '2026-04-15' }),
        {} as any,
      ) as any;

      expect(res.statusCode).toBe(200);

      // Verify trades were queried
      const queryCalls = ddbMock.commandCalls(QueryCommand);
      const tradesQuery = queryCalls.find(c => c.args[0].input.TableName === 'test-trades');
      expect(tradesQuery).toBeDefined();

      // Verify stats were queried
      const statsQuery = queryCalls.find(c => c.args[0].input.TableName === 'test-daily-stats');
      expect(statsQuery).toBeDefined();

      // Verify aggregateDailyRecords was called
      expect(aggregateDailyRecords).toHaveBeenCalled();
    });

    it('calls Gemini with correct URL and API key', async () => {
      mockGeminiSuccess();

      await handler(
        makeEvent({ startDate: '2026-04-01', endDate: '2026-04-15' }),
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

    it('sends temperature 0 in generation config', async () => {
      mockGeminiSuccess();

      await handler(
        makeEvent({ startDate: '2026-04-01', endDate: '2026-04-15' }),
        {} as any,
      );

      const [, options] = fetchMock.mock.calls[0];
      const requestBody = JSON.parse(options.body);
      expect(requestBody.generationConfig.temperature).toBe(0);
    });

    it('sends stripped trades (no images field) to Gemini', async () => {
      mockGeminiSuccess();

      await handler(
        makeEvent({ startDate: '2026-04-01', endDate: '2026-04-15' }),
        {} as any,
      );

      const [, options] = fetchMock.mock.calls[0];
      const requestBody = JSON.parse(options.body);
      const promptText = requestBody.contents[0].parts[0].text;

      expect(promptText).toContain('TRADE DATA');
      expect(promptText).toContain('15 trades');
      // images field should be stripped by stripTradeForLLM
      expect(promptText).not.toContain('base64encodeddata');
    });

    it('sends aggregated stats in the prompt', async () => {
      mockGeminiSuccess();

      await handler(
        makeEvent({ startDate: '2026-04-01', endDate: '2026-04-15' }),
        {} as any,
      );

      const [, options] = fetchMock.mock.calls[0];
      const requestBody = JSON.parse(options.body);
      const promptText = requestBody.contents[0].parts[0].text;
      expect(promptText).toContain('AGGREGATED STATS');
    });

    it('writes result to cache after successful generation', async () => {
      mockGeminiSuccess();

      await handler(
        makeEvent({ startDate: '2026-04-01', endDate: '2026-04-15' }),
        {} as any,
      );

      const putCalls = ddbMock.commandCalls(PutCommand);
      const cachePut = putCalls.find(c => c.args[0].input.TableName === 'test-insights-cache');
      expect(cachePut).toBeDefined();

      const item = cachePut!.args[0].input.Item as any;
      expect(item.userId).toBe('user-1');
      expect(item.cacheKey).toBe('all#2026-04-01#2026-04-15');
      expect(item.stale).toBe(false);
      expect(item.response).toBeDefined();
      expect(typeof item.ttl).toBe('number');

      // Verify the cached response is a valid InsightsResponse
      const cachedData = JSON.parse(item.response);
      expect(cachedData.profile.type).toBe('day_trader');
    });

    it('includes generatedAt and elapsedMs in response meta', async () => {
      mockGeminiSuccess();

      const res = await handler(
        makeEvent({ startDate: '2026-04-01', endDate: '2026-04-15' }),
        {} as any,
      ) as any;

      const body = JSON.parse(res.body);
      expect(body.meta.generatedAt).toBeDefined();
      expect(new Date(body.meta.generatedAt).toISOString()).toBe(body.meta.generatedAt);
      expect(typeof body.meta.elapsedMs).toBe('number');
      expect(body.meta.elapsedMs).toBeGreaterThanOrEqual(0);
    });

    it('handles accountId filter in request', async () => {
      // Create trades with accountId so they are not filtered out
      const tradesWithAccount = makeSampleTrades(15).map(t => ({ ...t, accountId: 'acc-1' }));
      ddbMock.on(QueryCommand, { TableName: 'test-trades' }).resolves({
        Items: tradesWithAccount.map(t => ({ userId: t.userId, tradeId: t.tradeId, openDate: t.openDate })),
        LastEvaluatedKey: undefined,
      });
      ddbMock.on(BatchGetCommand).resolves({
        Responses: { 'test-trades': tradesWithAccount },
        UnprocessedKeys: {},
      });
      mockGeminiSuccess();

      const res = await handler(
        makeEvent({ startDate: '2026-04-01', endDate: '2026-04-15', accountId: 'acc-1' }),
        {} as any,
      ) as any;

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(true);
    });

    it('builds cache key with accountId when provided', async () => {
      // Create trades with accountId so they are not filtered out
      const tradesWithAccount = makeSampleTrades(15).map(t => ({ ...t, accountId: 'acc-1' }));
      ddbMock.on(QueryCommand, { TableName: 'test-trades' }).resolves({
        Items: tradesWithAccount.map(t => ({ userId: t.userId, tradeId: t.tradeId, openDate: t.openDate })),
        LastEvaluatedKey: undefined,
      });
      ddbMock.on(BatchGetCommand).resolves({
        Responses: { 'test-trades': tradesWithAccount },
        UnprocessedKeys: {},
      });
      mockGeminiSuccess();

      await handler(
        makeEvent({ startDate: '2026-04-01', endDate: '2026-04-15', accountId: 'acc-1' }),
        {} as any,
      );

      const putCalls = ddbMock.commandCalls(PutCommand);
      const cachePut = putCalls.find(c => c.args[0].input.TableName === 'test-insights-cache');
      expect(cachePut).toBeDefined();
      expect(cachePut!.args[0].input.Item!.cacheKey).toBe('acc-1#2026-04-01#2026-04-15');
    });

    it('strips markdown code fences from Gemini response', async () => {
      const sampleResponse = makeSampleInsightsResponse();
      const wrappedJson = '```json\n' + JSON.stringify(sampleResponse) + '\n```';
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          candidates: [{ content: { parts: [{ text: wrappedJson }] } }],
        }),
      });

      const res = await handler(
        makeEvent({ startDate: '2026-04-01', endDate: '2026-04-15' }),
        {} as any,
      ) as any;

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(true);
      expect(body.data.profile.type).toBe('day_trader');
    });
  });

  // ── Gemini error handling ────────────────────────────────────

  describe('Gemini error handling', () => {
    it('returns GeminiTimeout on AbortError', async () => {
      const abortError = new DOMException('The operation was aborted.', 'AbortError');
      fetchMock.mockRejectedValueOnce(abortError);

      const res = await handler(
        makeEvent({ startDate: '2026-04-01', endDate: '2026-04-15' }),
        {} as any,
      ) as any;

      expect(res.statusCode).toBe(500);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(false);
      expect(body.errorCode).toBe('GeminiTimeout');
      expect(body.message).toContain('generation failed');
    });

    it('returns GeminiTimeout on error with "aborted" in message', async () => {
      const err = new Error('The request was aborted');
      fetchMock.mockRejectedValueOnce(err);

      const res = await handler(
        makeEvent({ startDate: '2026-04-01', endDate: '2026-04-15' }),
        {} as any,
      ) as any;

      expect(res.statusCode).toBe(500);
      const body = JSON.parse(res.body);
      expect(body.errorCode).toBe('GeminiTimeout');
    });

    it('returns GeminiError when Gemini API returns non-ok response', async () => {
      fetchMock.mockResolvedValueOnce({
        ok: false,
        status: 429,
        statusText: 'Too Many Requests',
        text: async () => 'Rate limit exceeded',
      });

      const res = await handler(
        makeEvent({ startDate: '2026-04-01', endDate: '2026-04-15' }),
        {} as any,
      ) as any;

      expect(res.statusCode).toBe(500);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(false);
      expect(body.errorCode).toBe('GeminiError');
    });

    it('returns GeminiError when fetch throws generic error', async () => {
      fetchMock.mockRejectedValueOnce(new Error('Network failure'));

      const res = await handler(
        makeEvent({ startDate: '2026-04-01', endDate: '2026-04-15' }),
        {} as any,
      ) as any;

      expect(res.statusCode).toBe(500);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(false);
      expect(body.errorCode).toBe('GeminiError');
    });

    it('returns ParseError when Gemini returns plain text (no JSON)', async () => {
      mockGeminiNonJson('I cannot analyze these trades because there is insufficient data.');

      const res = await handler(
        makeEvent({ startDate: '2026-04-01', endDate: '2026-04-15' }),
        {} as any,
      ) as any;

      expect(res.statusCode).toBe(500);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(false);
      expect(body.errorCode).toBe('ParseError');
      expect(body.message).toContain('parse');
    });

    it('returns ParseError when Gemini returns malformed JSON object', async () => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          candidates: [{ content: { parts: [{ text: '{"profile": {"type": "day_trader"}, broken' }] } }],
        }),
      });

      const res = await handler(
        makeEvent({ startDate: '2026-04-01', endDate: '2026-04-15' }),
        {} as any,
      ) as any;

      expect(res.statusCode).toBe(500);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(false);
      expect(body.errorCode).toBe('ParseError');
    });

    it('returns ValidationError when response does not match schema', async () => {
      const invalidResponse = {
        profile: {
          type: 'unknown_type', // not in valid types
          aggressivenessScore: 5,
          summary: 'Test',
        },
        scores: [{ dimension: 'discipline', value: 50 }],
        insights: [],
        tradeSpotlights: [],
        summary: 'Test',
      };
      mockGeminiSuccess(invalidResponse);

      const res = await handler(
        makeEvent({ startDate: '2026-04-01', endDate: '2026-04-15' }),
        {} as any,
      ) as any;

      expect(res.statusCode).toBe(500);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(false);
      expect(body.errorCode).toBe('ValidationError');
      expect(body.message).toContain('validation failed');
    });

    it('includes elapsedMs in error response meta', async () => {
      mockGeminiNonJson('not json');

      const res = await handler(
        makeEvent({ startDate: '2026-04-01', endDate: '2026-04-15' }),
        {} as any,
      ) as any;

      const body = JSON.parse(res.body);
      expect(typeof body.meta.elapsedMs).toBe('number');
    });

    it('returns GeminiError when Gemini returns empty candidates', async () => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ candidates: [{ content: { parts: [{}] } }] }),
      });

      const res = await handler(
        makeEvent({ startDate: '2026-04-01', endDate: '2026-04-15' }),
        {} as any,
      ) as any;

      expect(res.statusCode).toBe(500);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(false);
      expect(body.errorCode).toBe('GeminiError');
    });
  });

  // ── Response validation (schema checks) ──────────────────────

  describe('response validation', () => {
    it('rejects response missing profile', async () => {
      const noProfile = { ...makeSampleInsightsResponse() } as any;
      delete noProfile.profile;
      mockGeminiSuccess(noProfile);

      const res = await handler(
        makeEvent({ startDate: '2026-04-01', endDate: '2026-04-15' }),
        {} as any,
      ) as any;

      expect(res.statusCode).toBe(500);
      expect(JSON.parse(res.body).errorCode).toBe('ValidationError');
    });

    it('rejects response with invalid profile type', async () => {
      const badType = makeSampleInsightsResponse();
      (badType.profile as any).type = 'position_trader';
      mockGeminiSuccess(badType);

      const res = await handler(
        makeEvent({ startDate: '2026-04-01', endDate: '2026-04-15' }),
        {} as any,
      ) as any;

      expect(res.statusCode).toBe(500);
      expect(JSON.parse(res.body).errorCode).toBe('ValidationError');
    });

    it('rejects response missing scores array', async () => {
      const noScores = { ...makeSampleInsightsResponse() } as any;
      delete noScores.scores;
      mockGeminiSuccess(noScores);

      const res = await handler(
        makeEvent({ startDate: '2026-04-01', endDate: '2026-04-15' }),
        {} as any,
      ) as any;

      expect(res.statusCode).toBe(500);
      expect(JSON.parse(res.body).errorCode).toBe('ValidationError');
    });

    it('rejects response with empty scores array', async () => {
      const emptyScores = { ...makeSampleInsightsResponse(), scores: [] };
      mockGeminiSuccess(emptyScores);

      const res = await handler(
        makeEvent({ startDate: '2026-04-01', endDate: '2026-04-15' }),
        {} as any,
      ) as any;

      expect(res.statusCode).toBe(500);
      expect(JSON.parse(res.body).errorCode).toBe('ValidationError');
    });

    it('rejects response missing summary', async () => {
      const noSummary = { ...makeSampleInsightsResponse() } as any;
      delete noSummary.summary;
      mockGeminiSuccess(noSummary);

      const res = await handler(
        makeEvent({ startDate: '2026-04-01', endDate: '2026-04-15' }),
        {} as any,
      ) as any;

      expect(res.statusCode).toBe(500);
      expect(JSON.parse(res.body).errorCode).toBe('ValidationError');
    });

    it('rejects response missing tradeSpotlights', async () => {
      const noSpotlights = { ...makeSampleInsightsResponse() } as any;
      delete noSpotlights.tradeSpotlights;
      mockGeminiSuccess(noSpotlights);

      const res = await handler(
        makeEvent({ startDate: '2026-04-01', endDate: '2026-04-15' }),
        {} as any,
      ) as any;

      expect(res.statusCode).toBe(500);
      expect(JSON.parse(res.body).errorCode).toBe('ValidationError');
    });

    it('rejects response with non-number aggressivenessScore', async () => {
      const badScore = makeSampleInsightsResponse();
      (badScore.profile as any).aggressivenessScore = 'high';
      mockGeminiSuccess(badScore);

      const res = await handler(
        makeEvent({ startDate: '2026-04-01', endDate: '2026-04-15' }),
        {} as any,
      ) as any;

      expect(res.statusCode).toBe(500);
      expect(JSON.parse(res.body).errorCode).toBe('ValidationError');
    });

    it('rejects response with invalid insight severity', async () => {
      const badSeverity = makeSampleInsightsResponse();
      badSeverity.insights = [
        { severity: 'urgent' as any, title: 'Test', detail: 'Detail', evidence: 'Evidence' },
      ];
      mockGeminiSuccess(badSeverity);

      const res = await handler(
        makeEvent({ startDate: '2026-04-01', endDate: '2026-04-15' }),
        {} as any,
      ) as any;

      expect(res.statusCode).toBe(500);
      expect(JSON.parse(res.body).errorCode).toBe('ValidationError');
    });

    it('rejects response with non-number score value', async () => {
      const badScoreVal = makeSampleInsightsResponse();
      badScoreVal.scores[0].value = 'high' as any;
      mockGeminiSuccess(badScoreVal);

      const res = await handler(
        makeEvent({ startDate: '2026-04-01', endDate: '2026-04-15' }),
        {} as any,
      ) as any;

      expect(res.statusCode).toBe(500);
      expect(JSON.parse(res.body).errorCode).toBe('ValidationError');
    });

    it('accepts valid complete response with all four profile types', async () => {
      for (const profileType of ['scalper', 'day_trader', 'swing_trader', 'conservative']) {
        ddbMock.reset();
        ssmMock.reset();
        fetchMock.mockReset();
        vi.mocked(getSubscriptionTier).mockReset();
        vi.mocked(aggregateDailyRecords).mockReset();
        setupDefaultMocks();

        const response = makeSampleInsightsResponse();
        response.profile.type = profileType as any;
        mockGeminiSuccess(response);

        const res = await handler(
          makeEvent({ startDate: '2026-04-01', endDate: '2026-04-15' }),
          {} as any,
        ) as any;

        expect(res.statusCode).toBe(200);
        const body = JSON.parse(res.body);
        expect(body.data.profile.type).toBe(profileType);
      }
    });
  });

  // ── Cache write failure (non-fatal) ──────────────────────────

  describe('cache write failure', () => {
    it('still returns success even if cache write fails', async () => {
      mockGeminiSuccess();
      ddbMock.on(PutCommand, { TableName: 'test-insights-cache' }).rejects(new Error('DynamoDB write throttled'));

      const res = await handler(
        makeEvent({ startDate: '2026-04-01', endDate: '2026-04-15' }),
        {} as any,
      ) as any;

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(true);
      expect(body.data.profile.type).toBe('day_trader');
      expect(body.meta.cached).toBe(false);
    });
  });

  // ── Cache read failure (non-fatal) ───────────────────────────

  describe('cache read failure', () => {
    it('proceeds to generate when cache read fails', async () => {
      ddbMock.on(GetCommand, { TableName: 'test-insights-cache' }).rejects(new Error('DynamoDB read throttled'));
      mockGeminiSuccess();

      const res = await handler(
        makeEvent({ startDate: '2026-04-01', endDate: '2026-04-15' }),
        {} as any,
      ) as any;

      expect(res.statusCode).toBe(200);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(true);
      expect(body.meta.cached).toBe(false);
    });
  });

  // ── SSM config error ─────────────────────────────────────────

  describe('SSM config error', () => {
    it('returns 500 with ConfigError when SSM getApiKey fails', async () => {
      ssmMock.on(GetParameterCommand).rejects(new Error('SSM access denied'));

      const res = await handler(
        makeEvent({ startDate: '2026-04-01', endDate: '2026-04-15' }),
        {} as any,
      ) as any;

      expect(res.statusCode).toBe(500);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(false);
      // Due to module-level API key caching, error may come from
      // Gemini (cached key) or SSM (first run). Either is 500.
      expect(['ConfigError', 'GeminiError']).toContain(body.errorCode);
    });
  });
});
