import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
    process.env.AI_PROVIDER = 'gemini';
  });
  afterEach(() => {
    delete process.env.AI_PROVIDER;
  });

  it('builds JSON-mode body with system instruction and schema', () => {
    const b = buildBody({ system: 'S', contents: [{ role: 'user', parts: [{ text: 'U' }] }], temperature: 0.2, maxOutputTokens: 100, responseSchema: { type: 'OBJECT' } });
    expect(b.systemInstruction.parts[0].text).toBe('S');
    expect(b.generationConfig).toEqual({ temperature: 0.2, maxOutputTokens: 100, responseMimeType: 'application/json', responseSchema: { type: 'OBJECT' } });
    expect(JSON.stringify(b)).not.toMatch(/thinking/i);
    expect(b).not.toHaveProperty('tools');
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
    expect(a).toMatchObject({ model: 'gemini-3.5-flash-lite', status: 400 });
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
      { type: 'end', model: 'gemini-3.5-flash-lite', usage: { promptTokens: 5, outputTokens: 2 }, finishReason: 'STOP' },
    ]);
  });

  describe('one deadline and cancellation (BE-050, BE-048)', () => {
    const req = (extra: Record<string, unknown> = {}) => ({ system: 's', contents: [], temperature: 0, maxOutputTokens: 10, ...extra });

    it('the fallback model gets only what is left of the deadline', async () => {
      vi.useFakeTimers();
      const timeouts: number[] = [];
      const spy = vi.spyOn(AbortSignal, 'timeout').mockImplementation((ms: number) => { timeouts.push(ms); return new AbortController().signal; });
      const f = vi.fn().mockImplementationOnce(async () => { vi.advanceTimersByTime(30_000); return fail(503); }).mockResolvedValueOnce(okJson({ candidates: [{ content: { parts: [{ text: 'x' }] } }] }));
      await generate(req({ timeoutMs: 50_000 }), f as any);
      spy.mockRestore();
      vi.useRealTimers();
      expect(timeouts).toEqual([50_000, 20_000]);
    });

    it('a call without timeoutMs gets a 50 s deadline, below the Web Function timeout (BE-012)', async () => {
      const timeouts: number[] = [];
      const spy = vi.spyOn(AbortSignal, 'timeout').mockImplementation((ms: number) => { timeouts.push(ms); return new AbortController().signal; });
      const ok = () => okJson({ candidates: [{ content: { parts: [{ text: 'x' }] } }] });
      await generate(req(), vi.fn().mockResolvedValue(ok()) as any);
      const sse = vi.fn().mockResolvedValue({ ok: true, status: 200, body: new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode('data: {"candidates":[{"content":{"parts":[{"text":"x"}]}}]}\n\n')); c.close(); } }) } as unknown as Response);
      for await (const _ of stream(req(), sse as any)) { /* drain */ }
      spy.mockRestore();
      expect(timeouts).toHaveLength(2);
      expect(timeouts.every((ms) => ms <= 50_000 && ms > 49_000)).toBe(true);
    });

    it('no fallback when less than 10 s of the deadline is left', async () => {
      vi.useFakeTimers();
      const f = vi.fn().mockImplementationOnce(async () => { vi.advanceTimersByTime(45_000); return fail(503); }).mockResolvedValue(okJson({ candidates: [{ content: { parts: [{ text: 'x' }] } }] }));
      const err = await generate(req({ timeoutMs: 50_000 }), f as any).catch((e) => e);
      vi.useRealTimers();
      expect(f).toHaveBeenCalledTimes(1);
      expect(err).toBeInstanceOf(AiUnavailableError);
      expect(err).toMatchObject({ model: 'gemini-3.5-flash-lite', status: 503 });
    });

    it('the caller signal reaches fetch, and an aborted call stops without trying the fallback', async () => {
      const ctrl = new AbortController();
      const f = vi.fn().mockImplementationOnce(async (_url: string, init: any) => {
        ctrl.abort();
        expect(init.signal.aborted).toBe(true);
        throw new Error('aborted');
      });
      const err = await generate(req({ signal: ctrl.signal }), f as any).catch((e) => e);
      expect(err).toBeInstanceOf(AiUnavailableError);
      expect(f).toHaveBeenCalledTimes(1);
    });

    it('stream() passes the signal too', async () => {
      const ctrl = new AbortController();
      const f = vi.fn().mockImplementation(async () => ({ ok: true, status: 200, body: new ReadableStream({ start(c) { c.close(); } }) }) as unknown as Response);
      const it = stream(req({ signal: ctrl.signal }), f as any);
      await it.next();
      expect((f.mock.calls[0][1] as any).signal).not.toBe(ctrl.signal);
      ctrl.abort();
      expect((f.mock.calls[0][1] as any).signal.aborted).toBe(true);
    });
  });

  describe('stream() with an empty first model (BE-047)', () => {
    const sse = (text?: string) => {
      const wire = text ? `data: {"candidates":[{"content":{"parts":[{"text":"${text}"}]},"finishReason":"STOP"}]}\r\n\r\n` : 'data: {"candidates":[{"finishReason":"SAFETY"}]}\r\n\r\n';
      const bytes = new TextEncoder().encode(wire);
      return { ok: true, status: 200, body: new ReadableStream({ start(c) { c.enqueue(bytes); c.close(); } }) } as unknown as Response;
    };
    const collect = async (f: any) => {
      const out = [];
      for await (const ch of stream({ system: 's', contents: [], temperature: 0, maxOutputTokens: 10 }, f)) out.push(ch);
      return out;
    };

    it('falls back to the next model when the first yields no text before it ends', async () => {
      const f = vi.fn().mockResolvedValueOnce(sse()).mockResolvedValueOnce(sse('Hi'));
      const out = await collect(f);
      expect(f).toHaveBeenCalledTimes(2);
      expect(out.map((c) => c.type)).toEqual(['text', 'end']);
      expect(out[1]).toMatchObject({ model: 'gemini-2.5-flash-lite' });
    });

    it('when the last model is empty too the stream ends without text (the caller handles it)', async () => {
      const f = vi.fn().mockResolvedValueOnce(sse()).mockResolvedValueOnce(sse());
      const out = await collect(f);
      expect(out.map((c) => c.type)).toEqual(['end']);
    });
  });
});

