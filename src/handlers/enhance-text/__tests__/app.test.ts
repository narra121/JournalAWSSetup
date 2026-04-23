import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';
import type { APIGatewayProxyEventV2 } from 'aws-lambda';

// Stub env before importing handler
vi.stubEnv('GEMINI_API_KEY_PARAM', '/test/gemini-key');
vi.stubEnv('GEMINI_REQUEST_TIMEOUT_MS', '5000');

// Mock SSM
const ssmMock = mockClient(SSMClient);

// Mock global fetch
const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

vi.mock('../../../shared/subscription', () => ({
  checkSubscription: vi.fn().mockResolvedValue(null),
}));

const { handler } = await import('../app.ts');

// ─── Helpers ────────────────────────────────────────────────────

function makeEvent(body?: any, overrides: Partial<APIGatewayProxyEventV2> = {}): APIGatewayProxyEventV2 {
  return {
    version: '2.0',
    routeKey: 'POST /enhance-text',
    rawPath: '/enhance-text',
    rawQueryString: '',
    headers: {
      authorization: 'Bearer test-token',
    },
    requestContext: {
      accountId: '123',
      apiId: 'api',
      domainName: 'api.example.com',
      domainPrefix: 'api',
      http: { method: 'POST', path: '/enhance-text', protocol: 'HTTP/1.1', sourceIp: '127.0.0.1', userAgent: 'test' },
      requestId: 'req-1',
      routeKey: 'POST /enhance-text',
      stage: '$default',
      time: '01/Jan/2024:00:00:00 +0000',
      timeEpoch: 0,
    },
    body: body !== undefined ? (typeof body === 'string' ? body : JSON.stringify(body)) : undefined,
    isBase64Encoded: false,
    ...overrides,
  } as unknown as APIGatewayProxyEventV2;
}

function mockFetchSuccess(enhancedText: string) {
  fetchMock.mockResolvedValueOnce({
    ok: true,
    json: async () => ({
      candidates: [{ content: { parts: [{ text: enhancedText }] } }],
    }),
  });
}

// ─── Tests ──────────────────────────────────────────────────────

beforeEach(() => {
  ssmMock.reset();
  fetchMock.mockReset();
  // Default SSM returns a valid API key
  ssmMock.on(GetParameterCommand).resolves({
    Parameter: { Value: 'test-api-key-123' },
  });
});

describe('enhance-text handler', () => {
  it('returns 403 when subscription is inactive', async () => {
    const { checkSubscription } = await import('../../../shared/subscription');
    vi.mocked(checkSubscription).mockResolvedValueOnce({
      statusCode: 403,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ success: false, error: { code: 'SUBSCRIPTION_REQUIRED', message: 'Please subscribe', details: { reason: 'trial_expired' } } }),
    } as any);

    const header = btoa(JSON.stringify({ alg: 'RS256' }));
    const payload = btoa(JSON.stringify({ sub: 'user-1' }));
    const jwt = `${header}.${payload}.sig`;
    const res = await handler(makeEvent({ text: 'some text' }, { headers: { authorization: `Bearer ${jwt}` } }), {} as any) as any;

    expect(res.statusCode).toBe(403);
    const body = JSON.parse(res.body);
    expect(body.error.code).toBe('SUBSCRIPTION_REQUIRED');
  });

  // ── Success ─────────────────────────────────────────────────

  it('returns 200 with enhancedText on success', async () => {
    mockFetchSuccess('This is the enhanced version of the text.');

    const res = await handler(makeEvent({ text: 'some rough notes' }), {} as any) as any;

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(true);
    expect(body.data.enhancedText).toBe('This is the enhanced version of the text.');
  });

  // ── Input validation ────────────────────────────────────────

  it('returns 400 when body is missing', async () => {
    const event = makeEvent(undefined);
    event.body = undefined;
    const res = await handler(event, {} as any) as any;

    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(false);
    expect(body.message).toContain('Missing body');
  });

  it('returns 400 when body is invalid JSON', async () => {
    const res = await handler(makeEvent('{not-valid-json'), {} as any) as any;

    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(false);
    expect(body.message).toContain('Invalid JSON');
  });

  it('returns 400 when text field is empty', async () => {
    const res = await handler(makeEvent({ text: '   ' }), {} as any) as any;

    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(false);
    expect(body.message).toContain('Missing or empty text');
  });

  it('returns 400 when text field is missing', async () => {
    const res = await handler(makeEvent({ foo: 'bar' }), {} as any) as any;

    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(false);
  });

  // ── API errors ──────────────────────────────────────────────

  it('returns 502 when all models return non-OK status', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 429,
      text: async () => 'Rate limited',
    });
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 500,
      text: async () => 'Internal error',
    });

    const res = await handler(makeEvent({ text: 'test text' }), {} as any) as any;

    expect(res.statusCode).toBe(502);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(false);
    expect(body.errorCode).toBe('BadGateway');
  });

  it('returns 502 when AI model returns empty response', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        candidates: [{ content: { parts: [{ text: '' }] } }],
      }),
    });

    const res = await handler(makeEvent({ text: 'test text' }), {} as any) as any;

    expect(res.statusCode).toBe(502);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(false);
    expect(body.errorCode).toBe('BadGateway');
  });

  // ── Timeout ─────────────────────────────────────────────────

  it('returns 504 when fetch times out (AbortError)', async () => {
    const abortError = new DOMException('The operation was aborted.', 'AbortError');
    fetchMock.mockRejectedValueOnce(abortError);

    const res = await handler(makeEvent({ text: 'test text' }), {} as any) as any;

    expect(res.statusCode).toBe(504);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(false);
    expect(body.errorCode).toBe('GatewayTimeout');
  });

  // ── Internal error ──────────────────────────────────────────

  it('returns 500 when SSM getApiKey fails', async () => {
    ssmMock.on(GetParameterCommand).rejects(new Error('SSM access denied'));

    const res = await handler(makeEvent({ text: 'test text' }), {} as any) as any;

    expect(res.statusCode).toBe(500);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(false);
  });

  // ── Very long input text ───────────────────────────────────

  it('handles very long input text (>10000 chars) without crashing', async () => {
    const longText = 'A'.repeat(15000);
    mockFetchSuccess('Enhanced version of a long text.');

    const res = await handler(makeEvent({ text: longText }), {} as any) as any;

    // Should either succeed (forward to API) or reject with validation error
    expect([200, 400, 502]).toContain(res.statusCode);
    const body = JSON.parse(res.body);
    expect(body).toBeDefined();
  });

  it('handles extremely long input text (>100000 chars) without crashing', async () => {
    const veryLongText = 'B'.repeat(100000);
    mockFetchSuccess('Enhanced version.');

    const res = await handler(makeEvent({ text: veryLongText }), {} as any) as any;

    // Must not crash; should either succeed or return a controlled error
    expect([200, 400, 413, 500, 502]).toContain(res.statusCode);
    const body = JSON.parse(res.body);
    expect(body).toBeDefined();
  });

  // ── Input with HTML/script tags ────────────────────────────

  it('handles input with <script> tags safely', async () => {
    const xssText = '<script>alert("xss")</script> I traded well today';
    mockFetchSuccess('Enhanced: I traded well today.');

    const res = await handler(makeEvent({ text: xssText }), {} as any) as any;

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(true);
    // Verify the text was forwarded to the API (check fetch was called with the text)
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const fetchCallBody = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(fetchCallBody.contents[0].parts[0].text).toContain(xssText);
  });

  it('handles input with HTML event handlers safely', async () => {
    const xssText = '<img src=x onerror=alert(1)> Good trade';
    mockFetchSuccess('Enhanced: Good trade.');

    const res = await handler(makeEvent({ text: xssText }), {} as any) as any;

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(true);
    expect(body.data.enhancedText).toBeDefined();
  });

  // ── OpenRouter API returns malformed JSON ──────────────────

  it('returns 500 when Gemini API returns malformed JSON', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => { throw new SyntaxError('Unexpected token < in JSON at position 0'); },
    });

    const res = await handler(makeEvent({ text: 'test text' }), {} as any) as any;

    expect(res.statusCode).toBe(500);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(false);
  });

  // ── Gemini API returns empty/null response structures ──

  it('returns 502 when AI response has no candidates array', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({}),
    });

    const res = await handler(makeEvent({ text: 'test text' }), {} as any) as any;

    expect(res.statusCode).toBe(502);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(false);
  });

  it('returns 502 when AI response has empty candidates array', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ candidates: [] }),
    });

    const res = await handler(makeEvent({ text: 'test text' }), {} as any) as any;

    expect(res.statusCode).toBe(502);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(false);
  });

  it('returns 502 when AI response candidate has null content', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ candidates: [{ content: null }] }),
    });

    const res = await handler(makeEvent({ text: 'test text' }), {} as any) as any;

    expect(res.statusCode).toBe(502);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(false);
  });

  it('returns 502 when AI response content is whitespace-only', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        candidates: [{ content: { parts: [{ text: '   \n\t  ' }] } }],
      }),
    });

    const res = await handler(makeEvent({ text: 'test text' }), {} as any) as any;

    // The handler trims the content — whitespace-only becomes empty string
    expect(res.statusCode).toBe(502);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(false);
    expect(body.errorCode).toBe('BadGateway');
  });

  // ── Missing text field ─────────────────────────────────────

  it('returns 400 when text field is null', async () => {
    const res = await handler(makeEvent({ text: null }), {} as any) as any;

    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(false);
  });

  it('returns 400 when text field is a number', async () => {
    const res = await handler(makeEvent({ text: 12345 }), {} as any) as any;

    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(false);
  });

  it('returns 400 when text field is an object', async () => {
    const res = await handler(makeEvent({ text: { nested: 'value' } }), {} as any) as any;

    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(false);
  });

  it('returns 400 when text field is a boolean', async () => {
    const res = await handler(makeEvent({ text: true }), {} as any) as any;

    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(false);
  });

  // ── System prompt ──────────────────────────────────────────

  it('sends grammar correction system prompt', async () => {
    mockFetchSuccess('Corrected text.');

    const res = await handler(
      makeEvent({ text: 'some text with erors' }),
      {} as any,
    ) as any;

    expect(res.statusCode).toBe(200);
    const fetchCallBody = JSON.parse(fetchMock.mock.calls[0][1].body);
    const prompt = fetchCallBody.contents[0].parts[0].text;
    expect(prompt).toContain('grammar');
    expect(prompt).toContain('spelling');
  });

  // ── Error response does not leak API keys ──────────────────

  it('does not expose API key in error responses', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 401,
      text: async () => 'Invalid API key: test-api-key-123',
    });

    const res = await handler(makeEvent({ text: 'test text' }), {} as any) as any;

    expect(res.statusCode).toBe(502);
    const body = JSON.parse(res.body);
    const bodyStr = JSON.stringify(body);
    // Response should not contain the actual API key
    expect(bodyStr).not.toContain('test-api-key-123');
  });

  // ── Fetch network error ────────────────────────────────────

  it('returns 500 when fetch throws a network error', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'));

    const res = await handler(makeEvent({ text: 'test text' }), {} as any) as any;

    expect(res.statusCode).toBe(500);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(false);
  });

  // ── Model and config assertions ──────────────────────────────

  it('uses gemini-2.5-flash-lite as primary model', async () => {
    mockFetchSuccess('Enhanced text.');
    await handler(makeEvent({ text: 'test text' }), {} as any);

    const fetchUrl = fetchMock.mock.calls[0][0];
    expect(fetchUrl).toContain('gemini-2.5-flash-lite');
  });

  it('sends thinkingBudget: 0 in generationConfig', async () => {
    mockFetchSuccess('Enhanced text.');
    await handler(makeEvent({ text: 'test text' }), {} as any);

    const fetchCallBody = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(fetchCallBody.generationConfig.thinkingConfig).toEqual({ thinkingBudget: 0 });
  });

  it('sends maxOutputTokens: 2048 in generationConfig', async () => {
    mockFetchSuccess('Enhanced text.');
    await handler(makeEvent({ text: 'test text' }), {} as any);

    const fetchCallBody = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(fetchCallBody.generationConfig.maxOutputTokens).toBe(2048);
  });

  // ── Model fallback ──────────────────────────────────────────

  it('falls back to gemini-2.5-flash on 429 from primary model', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 429,
      text: async () => 'Rate limited',
    });
    mockFetchSuccess('Enhanced from fallback.');

    const res = await handler(makeEvent({ text: 'test text' }), {} as any) as any;

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.data.enhancedText).toBe('Enhanced from fallback.');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1][0]).toContain('gemini-2.5-flash');
  });

  it('falls back to gemini-2.5-flash on 503 from primary model', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 503,
      text: async () => 'Service unavailable',
    });
    mockFetchSuccess('Enhanced from fallback.');

    const res = await handler(makeEvent({ text: 'test text' }), {} as any) as any;

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.data.enhancedText).toBe('Enhanced from fallback.');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('does not retry on non-retryable error (e.g. 401)', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 401,
      text: async () => 'Unauthorized',
    });

    const res = await handler(makeEvent({ text: 'test text' }), {} as any) as any;

    expect(res.statusCode).toBe(502);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
