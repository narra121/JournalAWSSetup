import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';
import type { APIGatewayProxyEventV2 } from 'aws-lambda';

// Stub env before importing handler
vi.stubEnv('GEMINI_API_KEY_PARAM', '/test/gemini-key');
vi.stubEnv('GEMINI_REQUEST_TIMEOUT_MS', '5000');
// The direct Gemini rollback path; the OpenRouter default is covered at the end of the file.
vi.stubEnv('AI_PROVIDER', 'gemini');

// Mock SSM
const ssmMock = mockClient(SSMClient);

// Mock global fetch
const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

const { handler } = await import('../app.ts');

// ─── Helpers ────────────────────────────────────────────────────

function makeEvent(body?: any, overrides: Partial<APIGatewayProxyEventV2> = {}): APIGatewayProxyEventV2 {
  return {
    version: '2.0',
    routeKey: 'POST /enhance-text',
    rawPath: '/enhance-text',
    rawQueryString: '',
    headers: {
      authorization: `Bearer ${btoa(JSON.stringify({ alg: 'RS256' }))}.${btoa(JSON.stringify({ sub: 'user-1' }))}.sig`,
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
  // ── Success ─────────────────────────────────────────────────

  it('returns 200 with enhancedText on success', async () => {
    mockFetchSuccess('This is the enhanced version of the text.');

    const res = await handler(makeEvent({ text: 'some rough notes' }), {} as any) as any;

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(true);
    expect(body.data.enhancedText).toBe('This is the enhanced version of the text.');
  });

  it('logs one ai_call line with the model that answered, never the text', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      mockFetchSuccess('Fixed text.');
      await handler(makeEvent({ text: 'secret rough notes' }), {} as any);
      const lines = log.mock.calls.map((c) => String(c[0])).filter((l) => l.includes('ai_call'));
      expect(lines).toHaveLength(1);
      expect(JSON.parse(lines[0])).toMatchObject({ level: 'INFO', msg: 'ai_call', feature: 'enhance', model: 'gemini-2.5-flash-lite', userId: 'user-1', requestId: 'req-1' });
      expect(lines[0]).not.toMatch(/secret|Fixed text/);
    } finally {
      log.mockRestore();
    }
  });

  // ── Input validation ────────────────────────────────────────

  it('returns 400 when body is missing', async () => {
    const event = makeEvent(undefined);
    event.body = undefined;
    const res = await handler(event, {} as any) as any;

    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(false);
    expect(body.message).toBe('Type or paste some text to improve.');
  });

  it('returns 400 when body is invalid JSON', async () => {
    const res = await handler(makeEvent('{not-valid-json'), {} as any) as any;

    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(false);
    expect(body.message).toBe('The request body must be valid JSON.');
  });

  it('returns 400 when text field is empty', async () => {
    const res = await handler(makeEvent({ text: '   ' }), {} as any) as any;

    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(false);
    expect(body.message).toBe('Type or paste some text to improve.');
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
    expect(body.errorCode).toBe('BAD_GATEWAY');
  });

  it('returns 502 when AI model returns empty response', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        candidates: [{ content: { parts: [{ text: '' }] } }],
      }),
    });

    const res = await handler(makeEvent({ text: 'test text' }), {} as any) as any;

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(res.statusCode).toBe(502);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(false);
    expect(body.errorCode).toBe('BAD_GATEWAY');
  });

  // ── Timeout ─────────────────────────────────────────────────

  it('returns 504 when fetch times out (AbortError)', async () => {
    const abortError = new DOMException('The operation was aborted.', 'AbortError');
    fetchMock.mockRejectedValueOnce(abortError);

    const res = await handler(makeEvent({ text: 'test text' }), {} as any) as any;

    expect(res.statusCode).toBe(504);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(false);
    expect(body.errorCode).toBe('GATEWAY_TIMEOUT');
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

    // Over the 10,000-character cap: rejected before any model call
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).message).toContain('too long');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('accepts text at exactly the 10,000-character cap', async () => {
    mockFetchSuccess('ok');
    const res = (await handler(makeEvent({ text: 'A'.repeat(10000) }), {} as any)) as any;
    expect(res.statusCode).toBe(200);
  });

  it('returns 401 without a verified user and never calls the model', async () => {
    const res = (await handler(makeEvent({ text: 'hello' }, { headers: {} }), {} as any)) as any;
    expect(res.statusCode).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('handles extremely long input text (>100000 chars) without crashing', async () => {
    const veryLongText = 'B'.repeat(100000);
    mockFetchSuccess('Enhanced version.');

    const res = await handler(makeEvent({ text: veryLongText }), {} as any) as any;

    expect(res.statusCode).toBe(400);
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
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({}),
    });

    const res = await handler(makeEvent({ text: 'test text' }), {} as any) as any;

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(res.statusCode).toBe(502);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(false);
  });

  it('returns 502 when AI response has empty candidates array', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ candidates: [] }),
    });

    const res = await handler(makeEvent({ text: 'test text' }), {} as any) as any;

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(res.statusCode).toBe(502);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(false);
  });

  it('returns 502 when AI response candidate has null content', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ candidates: [{ content: null }] }),
    });

    const res = await handler(makeEvent({ text: 'test text' }), {} as any) as any;

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(res.statusCode).toBe(502);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(false);
  });

  it('returns 502 when AI response content is whitespace-only', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        candidates: [{ content: { parts: [{ text: '   \n\t  ' }] } }],
      }),
    });

    const res = await handler(makeEvent({ text: 'test text' }), {} as any) as any;

    // The handler trims the content — whitespace-only becomes empty string
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(res.statusCode).toBe(502);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(false);
    expect(body.errorCode).toBe('BAD_GATEWAY');
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

  it('sends no thinkingConfig (gemini-3.5-flash-lite answers 400 to thinkingBudget)', async () => {
    mockFetchSuccess('Enhanced text.');
    await handler(makeEvent({ text: 'test text' }), {} as any);

    const fetchCallBody = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(fetchCallBody.generationConfig).toEqual({ temperature: 0.2, maxOutputTokens: 8192 });
    expect(fetchMock.mock.calls[0][1].body).not.toMatch(/thinking/i);
  });

  it('allows an output as long as a 10,000-character note (maxOutputTokens 8192)', async () => {
    mockFetchSuccess('Enhanced text.');
    await handler(makeEvent({ text: 'test text' }), {} as any);

    const fetchCallBody = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(fetchCallBody.generationConfig.maxOutputTokens).toBe(8192);
  });

  it('returns 502 instead of a cut-off text when the model stopped at the token limit (BE-041)', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ candidates: [{ finishReason: 'MAX_TOKENS', content: { parts: [{ text: 'Half of the note' }] } }] }),
    });
    const res = await handler(makeEvent({ text: 'a long note' }), {} as any) as any;

    expect(res.statusCode).toBe(502);
    expect(JSON.parse(res.body).data).toBeUndefined();
  });

  it('accepts a reply with finishReason STOP', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ candidates: [{ finishReason: 'STOP', content: { parts: [{ text: 'Done.' }] } }] }),
    });
    const res = await handler(makeEvent({ text: 'dun' }), {} as any) as any;

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).data.enhancedText).toBe('Done.');
  });

  // ── Model fallback ──────────────────────────────────────────

  it('falls back to gemini-3.5-flash-lite on 429 from primary model', async () => {
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
    expect(fetchMock.mock.calls[1][0]).toContain('gemini-3.5-flash-lite');
  });

  it('falls back to gemini-3.5-flash-lite on 503 from primary model', async () => {
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

  it('falls back when the first model answers 400 naming an unsupported field', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 400,
      text: async () => JSON.stringify({ error: { code: 400, message: 'Request contains an invalid argument.', status: 'INVALID_ARGUMENT' } }),
    });
    mockFetchSuccess('Enhanced from fallback.');

    const res = await handler(makeEvent({ text: 'test text' }), {} as any) as any;

    expect(res.statusCode).toBe(200);
    expect(fetchMock.mock.calls[1][0]).toContain('gemini-3.5-flash-lite');
  });

  it('a 400 that names no unsupported field fails fast', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 400,
      text: async () => JSON.stringify({ error: { code: 400, message: 'API key not valid. Please pass a valid API key.', status: 'INVALID_ARGUMENT' } }),
    });

    const res = await handler(makeEvent({ text: 'test text' }), {} as any) as any;

    expect(res.statusCode).toBe(502);
    expect(fetchMock).toHaveBeenCalledTimes(1);
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

describe('enhance-text via OpenRouter (AI_PROVIDER=openrouter)', () => {
  const routerReply = (content: string, finish = 'stop') => ({
    ok: true,
    status: 200,
    json: async () => ({ model: 'google/gemini-3.5-flash-lite', choices: [{ finish_reason: finish, message: { role: 'assistant', content } }], usage: { prompt_tokens: 9, completion_tokens: 3, cost: 0.00001 } }),
  });

  beforeEach(() => {
    vi.stubEnv('AI_PROVIDER', 'openrouter');
    vi.stubEnv('OPENROUTER_API_KEY_PARAM', '/tradequt/openrouterApiKey');
    ssmMock.on(GetParameterCommand, { Name: '/tradequt/openrouterApiKey' }).resolves({ Parameter: { Value: 'router-key' } });
  });
  afterEach(() => {
    vi.stubEnv('AI_PROVIDER', 'gemini');
    vi.stubEnv('OPENROUTER_API_KEY_PARAM', undefined);
  });

  it('sends the text to google/gemini-3.5-flash-lite with data_collection deny and returns the corrected text', async () => {
    fetchMock.mockResolvedValueOnce(routerReply('I bought two lots.'));
    const res = (await handler(makeEvent({ text: 'i buyed two lot' }), {} as any)) as any;

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).data.enhancedText).toBe('I bought two lots.');
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://openrouter.ai/api/v1/chat/completions');
    expect(init.headers.Authorization).toBe('Bearer router-key');
    const sent = JSON.parse(init.body);
    expect(sent).toMatchObject({ model: 'google/gemini-3.5-flash-lite', temperature: 0.2, max_tokens: 8192, provider: { data_collection: 'deny' } });
    expect(sent.messages).toHaveLength(1);
    expect(sent.messages[0]).toMatchObject({ role: 'user', content: expect.stringContaining('i buyed two lot') });
    expect(init.body).not.toMatch(/thinking|reasoning/i);
    expect(res.body).not.toContain('router-key');
  });

  it('a reply cut at the token limit (finish_reason length) is a 502, not a partial note', async () => {
    fetchMock.mockResolvedValueOnce(routerReply('Half of the', 'length'));
    const res = (await handler(makeEvent({ text: 'a long note' }), {} as any)) as any;
    expect(res.statusCode).toBe(502);
  });

  it('429 and 402 (no credits) are a 502 after one call: there is no second model', async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 429, statusText: 'Too Many Requests', text: async () => 'Rate limited' });
    const limited = (await handler(makeEvent({ text: 'fix' }), {} as any)) as any;
    expect(limited.statusCode).toBe(502);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    fetchMock.mockReset();
    fetchMock.mockResolvedValueOnce({ ok: false, status: 402, statusText: 'Payment Required', text: async () => '{"error":{"code":402,"message":"Insufficient credits"}}' });
    const res = (await handler(makeEvent({ text: 'fix' }), {} as any)) as any;
    expect(res.statusCode).toBe(502);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('an empty answer is a 502 after one call', async () => {
    fetchMock.mockResolvedValue(routerReply(''));
    const res = (await handler(makeEvent({ text: 'fix' }), {} as any)) as any;
    expect(res.statusCode).toBe(502);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
