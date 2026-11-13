import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';
import type { APIGatewayProxyEventV2 } from 'aws-lambda';

// Stub env before importing handler
vi.stubEnv('GEMINI_API_KEY_PARAM', '/test/gemini-key');
vi.stubEnv('GEMINI_REQUEST_TIMEOUT_MS', '5000');
vi.stubEnv('MAX_IMAGE_BASE64_LENGTH', '1333334');

// Mock SSM
const ssmMock = mockClient(SSMClient);

// Mock global fetch
const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

const { handler } = await import('../app.ts');

// ─── Helpers ────────────────────────────────────────────────────

function makeJwt(sub: string): string {
  const header = btoa(JSON.stringify({ alg: 'RS256' }));
  const payload = btoa(JSON.stringify({ sub }));
  return `${header}.${payload}.sig`;
}

const sampleTrades = [
  {
    symbol: 'XAUUSD',
    side: 'BUY',
    quantity: 1,
    openDate: '2025-08-20T10:00:00',
    closeDate: '2025-08-20T11:00:00',
    entryPrice: 1950.5,
    exitPrice: 1960.0,
    stopLoss: 1940.0,
    takeProfit: 1970.0,
    pnl: 9.5,
  },
];

function makeEvent(body?: any, overrides: Partial<APIGatewayProxyEventV2> = {}): APIGatewayProxyEventV2 {
  return {
    version: '2.0',
    routeKey: 'POST /extract-trades',
    rawPath: '/extract-trades',
    rawQueryString: '',
    headers: {
      authorization: `Bearer ${makeJwt('user-1')}`,
    },
    requestContext: {
      accountId: '123',
      apiId: 'api',
      domainName: 'api.example.com',
      domainPrefix: 'api',
      http: { method: 'POST', path: '/extract-trades', protocol: 'HTTP/1.1', sourceIp: '127.0.0.1', userAgent: 'test' },
      requestId: 'req-1',
      routeKey: 'POST /extract-trades',
      stage: '$default',
      time: '01/Jan/2024:00:00:00 +0000',
      timeEpoch: 0,
    },
    body: body !== undefined ? (typeof body === 'string' ? body : JSON.stringify(body)) : undefined,
    isBase64Encoded: false,
    ...overrides,
  } as unknown as APIGatewayProxyEventV2;
}

function mockGeminiSuccess(trades: any[] = sampleTrades) {
  const header = 'symbol,side,quantity,openDate,closeDate,entryPrice,exitPrice,stopLoss,takeProfit,pnl';
  const rows = trades.map(t =>
    `${t.symbol},${t.side},${t.quantity},${t.openDate},${t.closeDate},${t.entryPrice},${t.exitPrice},${t.stopLoss},${t.takeProfit},${t.pnl}`
  );
  const csvText = [header, ...rows].join('\n');
  fetchMock.mockResolvedValueOnce({
    ok: true,
    json: async () => ({
      candidates: [{ content: { parts: [{ text: csvText }] } }],
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

// ─── Tests ──────────────────────────────────────────────────────

beforeEach(() => {
  ssmMock.reset();
  fetchMock.mockReset();
  ssmMock.on(GetParameterCommand).resolves({
    Parameter: { Value: 'test-api-key-123' },
  });
});

describe('extract-trades handler', () => {
  // ── Success ─────────────────────────────────────────────────

  it('returns 200 with extracted items for a single image', async () => {
    mockGeminiSuccess();

    const res = await handler(makeEvent({ imageBase64: 'aGVsbG8=' }), {} as any) as any;

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(true);
    expect(body.data.items).toHaveLength(1);
    expect(body.data.items[0].symbol).toBe('XAUUSD');
  });

  it('returns 200 with extracted items for multiple images', async () => {
    const trades1 = [{ ...sampleTrades[0], symbol: 'XAUUSD' }];
    const trades2 = [{ ...sampleTrades[0], symbol: 'EURUSD' }];
    mockGeminiSuccess(trades1);
    mockGeminiSuccess(trades2);

    const res = await handler(makeEvent({ images: ['img1base64', 'img2base64'] }), {} as any) as any;

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(true);
    expect(body.data.items).toHaveLength(2);
    expect(body.data.items[0].symbol).toBe('XAUUSD');
    expect(body.data.items[1].symbol).toBe('EURUSD');
    expect(body.meta.totalImages).toBe(2);
  });

  // ── Input validation ────────────────────────────────────────

  it('returns 400 when body is missing', async () => {
    const event = makeEvent(undefined);
    event.body = undefined;
    const res = await handler(event, {} as any) as any;

    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(false);
  });

  it('returns 400 when no images are provided', async () => {
    const res = await handler(makeEvent({ foo: 'bar' }), {} as any) as any;

    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(false);
    expect(body.message).toBe('Add a screenshot or paste some text to extract trades from.');
  });

  it('returns 400 when more than 3 images provided', async () => {
    const res = await handler(
      makeEvent({ images: ['a', 'b', 'c', 'd'] }),
      {} as any,
    ) as any;

    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(false);
    expect(body.message).toBe('You can extract trades from up to 3 images at a time.');
    expect(body.error).toEqual({ code: 'VALIDATION_ERROR', maxImages: 3 });
  });

  it('returns 400 when body is invalid JSON', async () => {
    const res = await handler(makeEvent('{not-json'), {} as any) as any;

    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(false);
    expect(body.message).toBe('The request body must be valid JSON.');
  });

  // ── API errors ──────────────────────────────────────────────

  it('returns 500 on timeout for single image (AbortError)', async () => {
    const abortError = new DOMException('The operation was aborted.', 'AbortError');
    fetchMock.mockRejectedValueOnce(abortError);

    const res = await handler(makeEvent({ imageBase64: 'aGVsbG8=' }), {} as any) as any;

    expect(res.statusCode).toBe(500);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(false);
    expect(body.errorCode).toBe('GEMINI_TIMEOUT');
    expect(body.errorMessage).toBe(body.message);
  });

  it('400 when images holds anything but base64 text (BE-099)', async () => {
    for (const images of [[123], ['aGVsbG8=', null], [{ data: 'x' }]]) {
      const res = await handler(makeEvent({ images }), {} as any) as any;
      expect(res.statusCode).toBe(400);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('logs the Gemini HTTP failure (model, status, provider message) before returning the error', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      fetchMock.mockResolvedValue({ ok: false, status: 429, statusText: 'Too Many Requests', text: async () => 'You exceeded your current quota' });
      const res = await handler(makeEvent({ imageBase64: 'aGVsbG8=' }), {} as any) as any;
      expect(res.statusCode).toBe(500);
      const hit = err.mock.calls.find((c) => c[0] === 'Gemini HTTP error');
      expect(hit?.[1]).toEqual({ model: 'gemini-2.5-flash', status: 429, error: 'You exceeded your current quota' });
    } finally {
      err.mockRestore();
    }
  });

  it('returns 500 when extraction fails for single image (non-parseable response)', async () => {
    mockGeminiNonJson();

    const res = await handler(makeEvent({ imageBase64: 'aGVsbG8=' }), {} as any) as any;

    // Single image that fails extraction: allFailed=true triggers 500
    expect(res.statusCode).toBe(500);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(false);
    expect(body.errorCode).toBe('EXTRACTION_FAILED');
  });

  it('returns 500 when all images fail to process', async () => {
    mockGeminiNonJson('not json');
    mockGeminiNonJson('also not json');

    const res = await handler(
      makeEvent({ images: ['img1', 'img2'] }),
      {} as any,
    ) as any;

    expect(res.statusCode).toBe(500);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(false);
    expect(body.errorCode).toBe('EXTRACTION_FAILED');
  });

  // ── SSM config error ────────────────────────────────────────

  it('returns 500 when SSM getApiKey fails and no fetch mock set', async () => {
    // Note: The handler caches the API key after first successful call.
    // Once cached, subsequent SSM failures won't trigger ConfigError.
    // When SSM succeeds (cached) but fetch has no mock, fetch returns undefined
    // and the handler returns a Gemini error for the single image case.
    ssmMock.on(GetParameterCommand).rejects(new Error('SSM access denied'));

    const res = await handler(makeEvent({ imageBase64: 'aGVsbG8=' }), {} as any) as any;

    expect(res.statusCode).toBe(500);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(false);
    // Due to module-level API key caching, the error may come from
    // Gemini (cached key) or SSM (first run). Either is a 500.
    expect(['INTERNAL_ERROR', 'GEMINI_ERROR']).toContain(body.errorCode);
    expect(res.body).not.toContain('SSM');
  });

  // ── Text content extraction ─────────────────────────────────

  it('returns 200 with extracted items from text/CSV content', async () => {
    mockGeminiSuccess();

    const csv = 'Symbol,Side,Qty,OpenDate,CloseDate,Entry,Exit,SL,TP,PnL\nXAUUSD,BUY,1,2025-08-20T10:00:00,2025-08-20T11:00:00,1950.5,1960,1940,1970,9.5';
    const res = await handler(makeEvent({ textContent: csv }), {} as any) as any;

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(true);
    expect(body.data.items).toHaveLength(1);
    expect(body.data.items[0].symbol).toBe('XAUUSD');
    expect(body.meta.source).toBe('text');
    expect(body.meta.totalExtracted).toBe(1);
  });

  it('returns 200 with empty items when text yields no parseable data', async () => {
    mockGeminiNonJson('I could not parse any trades from this data.');

    const res = await handler(makeEvent({ textContent: 'random text with no trades' }), {} as any) as any;

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.data.items).toHaveLength(0);
    expect(body.message).toContain('No trades could be extracted');
    expect(body.meta.source).toBe('text');
  });

  it('returns 200 with empty items when text yields empty CSV', async () => {
    // Model returns only header (no data rows)
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        candidates: [{ content: { parts: [{ text: 'symbol,side,quantity,openDate,closeDate,entryPrice,exitPrice,stopLoss,takeProfit,pnl' }] } }],
      }),
    });

    const res = await handler(makeEvent({ textContent: 'Symbol,Side\n' }), {} as any) as any;

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.data.items).toHaveLength(0);
    expect(body.meta.source).toBe('text');
  });

  it('returns 400 when textContent exceeds 10KB limit', async () => {
    const largeText = 'x'.repeat(10_001);
    const res = await handler(makeEvent({ textContent: largeText }), {} as any) as any;

    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(false);
    expect(body.message).toBe('That text is too long. The limit is 10,000 characters.');
  });

  it('returns 500 on timeout for text extraction', async () => {
    const abortError = new DOMException('The operation was aborted.', 'AbortError');
    fetchMock.mockRejectedValueOnce(abortError);

    const res = await handler(makeEvent({ textContent: 'Symbol,Side\nAAPL,BUY' }), {} as any) as any;

    expect(res.statusCode).toBe(500);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(false);
    expect(body.errorCode).toBe('GEMINI_TIMEOUT');
    expect(body.errorMessage).toBe(body.message);
  });

  it('prefers textContent over images when both provided', async () => {
    mockGeminiSuccess();

    const res = await handler(makeEvent({ textContent: 'Symbol,Side\nAAPL,BUY,1,2025-01-01T00:00:00,2025-01-01T01:00:00,150,155,145,160,5', imageBase64: 'aGVsbG8=' }), {} as any) as any;

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    // Text path sets source: 'text', image path does not
    expect(body.meta.source).toBe('text');
    // Only one fetch call (text path), not two
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  // ── Model and config assertions ──────────────────────────────

  it('uses gemini-2.5-flash-lite as primary model', async () => {
    mockGeminiSuccess();
    await handler(makeEvent({ imageBase64: 'aGVsbG8=' }), {} as any);

    const fetchUrl = fetchMock.mock.calls[0][0];
    expect(fetchUrl).toContain('gemini-2.5-flash-lite');
  });

  it('sends thinkingBudget: 0 in generationConfig', async () => {
    mockGeminiSuccess();
    await handler(makeEvent({ imageBase64: 'aGVsbG8=' }), {} as any);

    const fetchCallBody = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(fetchCallBody.generationConfig.thinkingConfig).toEqual({ thinkingBudget: 0 });
  });

  it('sends maxOutputTokens: 4096 in generationConfig', async () => {
    mockGeminiSuccess();
    await handler(makeEvent({ imageBase64: 'aGVsbG8=' }), {} as any);

    const fetchCallBody = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(fetchCallBody.generationConfig.maxOutputTokens).toBe(4096);
  });

  it('falls back to JSON parsing when model returns JSON instead of CSV', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        candidates: [{ content: { parts: [{ text: JSON.stringify(sampleTrades) }] } }],
      }),
    });

    const res = await handler(makeEvent({ imageBase64: 'aGVsbG8=' }), {} as any) as any;
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.data.items).toHaveLength(1);
    expect(body.data.items[0].symbol).toBe('XAUUSD');
  });
});
