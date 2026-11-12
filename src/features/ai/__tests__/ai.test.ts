import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SseParser, sseFrame, ssePing } from '../sse';
import { isAdviceRequest } from '../../chat/guard';

vi.mock('@aws-sdk/client-ssm', () => ({
  SSMClient: class {
    send = vi.fn(async () => ({ Parameter: { Value: 'test-key' } }));
  },
  GetParameterCommand: class {
    constructor(public input: unknown) {}
  },
}));

import { generate, stream, buildBody, __resetGeminiKeyCache, AiUnavailableError } from '../gemini';

describe('sse framing', () => {
  it('frames JSON and multi-line data', () => {
    expect(sseFrame('token', { t: 'hi' })).toBe('event: token\ndata: {"t":"hi"}\n\n');
    expect(sseFrame('note', 'a\nb')).toBe('event: note\ndata: a\ndata: b\n\n');
  });
  it('parser round-trips frames split at every byte, ignores comments, handles CRLF', () => {
    const wire = sseFrame('token', { t: 'Hel' }) + ssePing + sseFrame('token', { t: 'lo\n' }) + 'event: done\r\ndata: {"ok":true}\r\n\r\n';
    const p = new SseParser();
    const got = [];
    for (const ch of wire) got.push(...p.push(ch));
    got.push(...p.end());
    expect(got).toEqual([
      { event: 'token', data: '{"t":"Hel"}' },
      { event: 'token', data: '{"t":"lo\\n"}' },
      { event: 'done', data: '{"ok":true}' },
    ]);
  });
  it('flushes an unterminated final event', () => {
    const p = new SseParser();
    expect(p.push('data: x')).toEqual([]);
    expect(p.end()).toEqual([{ event: 'message', data: 'x' }]);
  });
});

describe('advice guard', () => {
  it.each([
    'Should I buy BANKNIFTY call options tomorrow morning? Give me an entry and target.',
    'Which stock should I buy for intraday?',
    'give me tips for tomorrow',
    'Will Nifty go up tomorrow?',
    'buy or sell reliance?',
    'kal kaunsa share kharidu?',
    'call do bhai',
    'Recommend some strikes for expiry',
  ])('refuses: %s', (q) => expect(isAdviceRequest(q)).toBe(true));
  it.each([
    'Which setup lost me the most money, and how much?',
    'Say hi in one word.',
    'Why do I lose on Mondays?',
    'How did my BANKNIFTY call options perform last month?',
    'What is my win rate after 2 losses in a row?',
    'Should I stop trading after lunch based on my data?',
    'tell me about my best trade',
  ])('allows: %s', (q) => expect(isAdviceRequest(q)).toBe(false));
});

const okJson = (body: unknown) => ({ ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) }) as unknown as Response;
const fail = (status: number) => ({ ok: false, status, text: async () => 'err', json: async () => ({}) }) as unknown as Response;

describe('gemini client', () => {
  beforeEach(() => {
    __resetGeminiKeyCache();
    process.env.GEMINI_API_KEY_PARAM = '/test/gemini';
  });

  it('builds JSON-mode body with system instruction and schema', () => {
    const b = buildBody({ system: 'S', contents: [{ role: 'user', parts: [{ text: 'U' }] }], temperature: 0.2, maxOutputTokens: 100, responseSchema: { type: 'OBJECT' } });
    expect(b.systemInstruction.parts[0].text).toBe('S');
    expect(b.generationConfig).toMatchObject({ responseMimeType: 'application/json', responseSchema: { type: 'OBJECT' }, thinkingConfig: { thinkingBudget: 0 } });
  });

  it('falls back to the next model on 429 and returns text + usage', async () => {
    const f = vi.fn()
      .mockResolvedValueOnce(fail(429))
      .mockResolvedValueOnce(okJson({ candidates: [{ content: { parts: [{ text: '{"a":1}' }] } }], usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 3 } }));
    const r = await generate({ system: 's', contents: [], temperature: 0, maxOutputTokens: 10 }, f as any);
    expect(f).toHaveBeenCalledTimes(2);
    expect(f.mock.calls[1][0]).toContain('gemini-2.5-flash-lite:generateContent');
    expect(f.mock.calls[0][1].headers['x-goog-api-key']).toBe('test-key');
    expect(r).toEqual({ text: '{"a":1}', model: 'gemini-2.5-flash-lite', usage: { promptTokens: 10, outputTokens: 3 } });
  });

  it('throws AiUnavailableError on non-retryable status', async () => {
    const f = vi.fn().mockResolvedValue(fail(400));
    await expect(generate({ system: 's', contents: [], temperature: 0, maxOutputTokens: 10 }, f as any)).rejects.toBeInstanceOf(AiUnavailableError);
  });

  it('the error carries the model and HTTP status of the last failed attempt', async () => {
    const a = await generate({ system: 's', contents: [], temperature: 0, maxOutputTokens: 10 }, vi.fn().mockResolvedValue(fail(400)) as any).catch((e) => e);
    expect(a).toMatchObject({ model: 'gemini-2.5-flash', status: 400 });
    const b = await generate({ system: 's', contents: [], temperature: 0, maxOutputTokens: 10 }, vi.fn().mockResolvedValue(fail(429)) as any).catch((e) => e);
    expect(b).toMatchObject({ model: 'gemini-2.5-flash-lite', status: 429 });
    expect(b.message).toMatch(/^gemini-2\.5-flash-lite 429/);
  });

  it('streams SSE chunks split across reads', async () => {
    const wire =
      'data: {"candidates":[{"content":{"parts":[{"text":"Hello"}]}}]}\r\n\r\n' +
      'data: {"candidates":[{"content":{"parts":[{"text":" world"}]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":5,"candidatesTokenCount":2}}\r\n\r\n';
    const bytes = new TextEncoder().encode(wire);
    const body = new ReadableStream({
      start(c) {
        for (let i = 0; i < bytes.length; i += 7) c.enqueue(bytes.slice(i, i + 7));
        c.close();
      },
    });
    const f = vi.fn().mockResolvedValue({ ok: true, status: 200, body } as unknown as Response);
    const out = [];
    for await (const ch of stream({ system: 's', contents: [], temperature: 0, maxOutputTokens: 10 }, f as any)) out.push(ch);
    expect(out).toEqual([
      { type: 'text', text: 'Hello' },
      { type: 'text', text: ' world' },
      { type: 'end', model: 'gemini-2.5-flash', usage: { promptTokens: 5, outputTokens: 2 }, finishReason: 'STOP' },
    ]);
  });
});
