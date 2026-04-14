import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';
import type { APIGatewayProxyEventV2 } from 'aws-lambda';

// Stub env before importing handler
vi.stubEnv('OPENROUTER_API_KEY_PARAM', '/test/openrouter-key');
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
      choices: [{ message: { content: enhancedText } }],
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

  it('returns 502 when OpenRouter API returns non-OK status', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 429,
      text: async () => 'Rate limited',
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
        choices: [{ message: { content: '' } }],
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
    expect(fetchCallBody.messages[1].content).toBe(xssText);
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

  it('returns 500 when OpenRouter API returns malformed JSON', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => { throw new SyntaxError('Unexpected token < in JSON at position 0'); },
    });

    const res = await handler(makeEvent({ text: 'test text' }), {} as any) as any;

    expect(res.statusCode).toBe(500);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(false);
  });

  // ── OpenRouter API returns empty/null response structures ──

  it('returns 502 when AI response has no choices array', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({}),
    });

    const res = await handler(makeEvent({ text: 'test text' }), {} as any) as any;

    expect(res.statusCode).toBe(502);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(false);
  });

  it('returns 502 when AI response has empty choices array', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ choices: [] }),
    });

    const res = await handler(makeEvent({ text: 'test text' }), {} as any) as any;

    expect(res.statusCode).toBe(502);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(false);
  });

  it('returns 502 when AI response choice has null message', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ choices: [{ message: null }] }),
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
        choices: [{ message: { content: '   \n\t  ' } }],
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

  // ── isTradingNotes flag ────────────────────────────────────

  it('includes motivational prompt when isTradingNotes is true', async () => {
    mockFetchSuccess('Enhanced text with quote.\n\n"Stay disciplined."');

    const res = await handler(
      makeEvent({ text: 'My trade notes', isTradingNotes: true }),
      {} as any,
    ) as any;

    expect(res.statusCode).toBe(200);
    // Verify the system prompt includes motivational quote instruction
    const fetchCallBody = JSON.parse(fetchMock.mock.calls[0][1].body);
    const systemPrompt = fetchCallBody.messages[0].content;
    expect(systemPrompt).toContain('motivational quote');
  });

  it('does not include motivational prompt when isTradingNotes is false', async () => {
    mockFetchSuccess('Enhanced text.');

    const res = await handler(
      makeEvent({ text: 'Image description', isTradingNotes: false }),
      {} as any,
    ) as any;

    expect(res.statusCode).toBe(200);
    const fetchCallBody = JSON.parse(fetchMock.mock.calls[0][1].body);
    const systemPrompt = fetchCallBody.messages[0].content;
    expect(systemPrompt).not.toContain('motivational quote');
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
});
