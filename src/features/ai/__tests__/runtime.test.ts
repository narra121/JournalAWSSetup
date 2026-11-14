import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const ssmNames = vi.hoisted(() => [] as string[]);
vi.mock('@aws-sdk/client-ssm', () => ({
  SSMClient: class {
    send = vi.fn(async (cmd: { input: { Name: string } }) => {
      ssmNames.push(cmd.input.Name);
      return { Parameter: { Value: `key-for-${cmd.input.Name}` } };
    });
  },
  GetParameterCommand: class {
    constructor(public input: unknown) {}
  },
}));

import { AiUnavailableError, buildBody, GEMINI_MODELS, generate, stream, toGeminiSchema, toolCallTurn, toolResultTurn, __resetGeminiKeyCache, type GeminiRequest } from '../gemini';
import { __resetOpenRouterKeyCache } from '../openrouter';

const okJson = (body: unknown) => ({ ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) }) as unknown as Response;
const fail = (status: number, body = 'err') => ({ ok: false, status, text: async () => body, json: async () => ({}) }) as unknown as Response;
const googleError = (message: string) => JSON.stringify({ error: { code: 400, message, status: 'INVALID_ARGUMENT' } });
const answer = (parts: unknown[], extra: Record<string, unknown> = {}) => okJson({ candidates: [{ content: { role: 'model', parts }, finishReason: 'STOP', ...extra }], usageMetadata: { promptTokenCount: 7, candidatesTokenCount: 3 } });
const sseBody = (frames: unknown[], opts: { failAfter?: boolean } = {}) => {
  const enc = new TextEncoder();
  const queue = frames.map((f) => enc.encode(`data: ${JSON.stringify(f)}\r\n\r\n`));
  return new ReadableStream({
    pull(c) {
      const next = queue.shift();
      if (next) c.enqueue(next);
      else if (opts.failAfter) c.error(new Error('socket hang up'));
      else c.close();
    },
  });
};
const sseOk = (frames: unknown[], opts?: { failAfter?: boolean }) => ({ ok: true, status: 200, body: sseBody(frames, opts) }) as unknown as Response;
const req = (extra: Partial<GeminiRequest> = {}): GeminiRequest => ({ system: 's', contents: [{ role: 'user', parts: [{ text: 'q' }] }], temperature: 0.3, maxOutputTokens: 50, ...extra });
const collect = async (it: AsyncGenerator<any>) => {
  const out = [];
  for await (const c of it) out.push(c);
  return out;
};
const sentBody = (f: any, i = 0) => JSON.parse(f.mock.calls[i][1].body);

const TOOL = {
  name: 'query_trades',
  description: 'Stats over the trades',
  parameters: {
    type: 'object',
    properties: { groupBy: { type: 'array', items: { type: 'string', enum: ['symbol', 'setup'] }, maxItems: 2 }, symbol: { type: ['string', 'null'] } },
    required: ['groupBy'],
    additionalProperties: false,
  },
};

beforeEach(() => {
  __resetGeminiKeyCache();
  __resetOpenRouterKeyCache();
  ssmNames.length = 0;
  process.env.GEMINI_API_KEY_PARAM = '/test/gemini';
  process.env.AI_PROVIDER = 'gemini';
});
afterEach(() => {
  delete process.env.AI_PROVIDER;
  delete process.env.OPENROUTER_API_KEY_PARAM;
});

describe('model order per purpose', () => {
  it('reports and chat start on gemini-3.5-flash-lite, extraction on gemini-2.5-flash-lite', async () => {
    expect(GEMINI_MODELS).toEqual({
      report: ['gemini-3.5-flash-lite', 'gemini-2.5-flash-lite'],
      chat: ['gemini-3.5-flash-lite', 'gemini-2.5-flash-lite'],
      extract: ['gemini-2.5-flash-lite', 'gemini-3.5-flash-lite'],
    });
    for (const [purpose, first] of [[undefined, 'gemini-3.5-flash-lite'], ['report', 'gemini-3.5-flash-lite'], ['chat', 'gemini-3.5-flash-lite'], ['extract', 'gemini-2.5-flash-lite']] as const) {
      const f = vi.fn().mockResolvedValue(answer([{ text: 'x' }]));
      const r = await generate(req({ purpose }), f as any);
      expect(f.mock.calls[0][0]).toBe(`https://generativelanguage.googleapis.com/v1beta/models/${first}:generateContent`);
      expect(r.model).toBe(first);
    }
  });

  it('no request carries a thinking setting, on any model, streamed or not', async () => {
    const f = vi.fn().mockResolvedValueOnce(fail(503)).mockResolvedValueOnce(answer([{ text: 'x' }]));
    await generate(req({ responseSchema: { type: 'OBJECT' }, tools: [TOOL] }), f as any);
    const s = vi.fn().mockResolvedValueOnce(fail(503)).mockResolvedValueOnce(sseOk([{ candidates: [{ content: { parts: [{ text: 'x' }] }, finishReason: 'STOP' }] }]));
    await collect(stream(req(), s as any));
    for (const call of [...f.mock.calls, ...s.mock.calls]) {
      expect(call[1].body).not.toMatch(/thinking/i);
      expect(JSON.parse(call[1].body).generationConfig).not.toHaveProperty('thinkingConfig');
    }
    expect(f).toHaveBeenCalledTimes(2);
    expect(s).toHaveBeenCalledTimes(2);
  });
});

describe('400 naming an unsupported field', () => {
  it.each([
    'Request contains an invalid argument.',
    'Thinking level is not supported for this model.',
    'Invalid JSON payload received. Unknown name "foo" at \'generation_config\': Cannot find field.',
  ])('falls through to the next model: %s', async (message) => {
    const f = vi.fn().mockResolvedValueOnce(fail(400, googleError(message))).mockResolvedValueOnce(answer([{ text: 'ok' }]));
    const r = await generate(req(), f as any);
    expect(f).toHaveBeenCalledTimes(2);
    expect(f.mock.calls[1][0]).toContain('models/gemini-2.5-flash-lite:generateContent');
    expect(r).toMatchObject({ text: 'ok', model: 'gemini-2.5-flash-lite' });
  });

  it('stream() falls through the same way before the first byte', async () => {
    const f = vi.fn().mockResolvedValueOnce(fail(400, googleError('Request contains an invalid argument.'))).mockResolvedValueOnce(sseOk([{ candidates: [{ content: { parts: [{ text: 'Hi' }] }, finishReason: 'STOP' }] }]));
    const out = await collect(stream(req(), f as any));
    expect(out.map((c) => c.type)).toEqual(['text', 'end']);
    expect(out[1].model).toBe('gemini-2.5-flash-lite');
  });

  it('other 400s still fail fast', async () => {
    for (const body of [googleError('API key not valid. Please pass a valid API key.'), googleError('Function call is missing a thought_signature in functionCall parts.'), 'err']) {
      const f = vi.fn().mockResolvedValue(fail(400, body));
      const err = await generate(req(), f as any).catch((e) => e);
      expect(err).toBeInstanceOf(AiUnavailableError);
      expect(err).toMatchObject({ model: 'gemini-3.5-flash-lite', status: 400 });
      expect(f).toHaveBeenCalledTimes(1);
    }
  });

  it('the last model answering 400 unsupported ends the call with that error', async () => {
    const f = vi.fn().mockResolvedValue(fail(400, googleError('Request contains an invalid argument.')));
    const err = await generate(req(), f as any).catch((e) => e);
    expect(f).toHaveBeenCalledTimes(2);
    expect(err).toMatchObject({ model: 'gemini-2.5-flash-lite', status: 400 });
  });
});

describe('empty answers and safety blocks', () => {
  it('a blocked prompt (no candidates) and a SAFETY candidate fall through; the error names the reason', async () => {
    const f = vi.fn().mockResolvedValueOnce(okJson({ promptFeedback: { blockReason: 'PROHIBITED_CONTENT' } })).mockResolvedValueOnce(okJson({ candidates: [{ finishReason: 'SAFETY' }] }));
    const err = await generate(req(), f as any).catch((e) => e);
    expect(f).toHaveBeenCalledTimes(2);
    expect(err).toBeInstanceOf(AiUnavailableError);
    expect(err.message).toBe('gemini-2.5-flash-lite empty response (SAFETY)');
    expect(err.status).toBe(200);
  });

  it('thought parts are not answer text, and a body that is not JSON counts as a failed attempt', async () => {
    const f = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => { throw new SyntaxError('Unexpected token <'); } } as unknown as Response)
      .mockResolvedValueOnce(answer([{ text: 'plan', thought: true }, { text: 'Answer' }]));
    const r = await generate(req(), f as any);
    expect(r).toEqual({ text: 'Answer', model: 'gemini-2.5-flash-lite', usage: { promptTokens: 7, outputTokens: 3 }, finishReason: 'STOP' });
  });
});

describe('tools (function calling)', () => {
  it('maps tools to functionDeclarations with the JSON Schema turned into the Gemini subset', () => {
    const b = buildBody(req({ tools: [TOOL, { name: 'list_rules', description: 'All rules', parameters: { type: 'object', properties: {} } }] }));
    expect(b.tools).toEqual([
      {
        functionDeclarations: [
          {
            name: 'query_trades',
            description: 'Stats over the trades',
            parameters: {
              type: 'OBJECT',
              properties: { groupBy: { type: 'ARRAY', items: { type: 'STRING', enum: ['symbol', 'setup'] }, maxItems: 2 }, symbol: { type: 'STRING', nullable: true } },
              required: ['groupBy'],
            },
          },
          { name: 'list_rules', description: 'All rules' },
        ],
      },
    ]);
  });

  it('toGeminiSchema leaves the Gemini dialect as it is and folds null unions into nullable', () => {
    const gemini = { type: 'OBJECT', required: ['a'], properties: { a: { type: 'STRING', enum: ['x'] }, b: { type: 'ARRAY', minItems: 3, maxItems: 8, items: { type: 'NUMBER' } } } };
    expect(toGeminiSchema(gemini)).toEqual(gemini);
    expect(toGeminiSchema({ anyOf: [{ type: 'integer', minimum: 1 }, { type: 'null' }], description: 'n', $schema: 'x', default: 3 })).toEqual({ type: 'INTEGER', minimum: 1, nullable: true, description: 'n' });
    expect(toGeminiSchema({ type: 'string', enum: ['a', null], format: 'email' })).toEqual({ type: 'STRING', enum: ['a'], nullable: true });
  });

  it('returns toolCalls with id and thought signature, and the round trip sends them back', async () => {
    const f = vi
      .fn()
      .mockResolvedValueOnce(answer([{ functionCall: { id: 'fc1', name: 'query_trades', args: { groupBy: ['symbol'] } }, thoughtSignature: 'SIG1' }, { functionCall: { id: 'fc2', name: 'list_rules', args: {} } }]))
      .mockResolvedValueOnce(answer([{ text: 'XAUUSD lost the most.' }]));
    const first = await generate(req({ tools: [TOOL] }), f as any);
    expect(first.text).toBe('');
    expect(first.toolCalls).toEqual([
      { name: 'query_trades', args: { groupBy: ['symbol'] }, id: 'fc1', thoughtSignature: 'SIG1' },
      { name: 'list_rules', args: {}, id: 'fc2' },
    ]);
    const calls = first.toolCalls!;
    const contents = [...req().contents, toolCallTurn(calls), toolResultTurn([{ call: calls[0], result: { rows: [['XAUUSD', -120]] } }, { call: calls[1], result: ['no revenge trades'] }])];
    const second = await generate(req({ tools: [TOOL], contents }), f as any);
    expect(second).toMatchObject({ text: 'XAUUSD lost the most.' });
    expect(second.toolCalls).toBeUndefined();
    expect(sentBody(f, 1).contents.slice(1)).toEqual([
      {
        role: 'model',
        parts: [
          { functionCall: { name: 'query_trades', args: { groupBy: ['symbol'] }, id: 'fc1' }, thoughtSignature: 'SIG1' },
          { functionCall: { name: 'list_rules', args: {}, id: 'fc2' } },
        ],
      },
      {
        role: 'user',
        parts: [
          { functionResponse: { name: 'query_trades', response: { rows: [['XAUUSD', -120]] }, id: 'fc1' } },
          { functionResponse: { name: 'list_rules', response: { result: ['no revenge trades'] }, id: 'fc2' } },
        ],
      },
    ]);
  });

  it('a call without a signature (served by 2.5) gets the documented placeholder on 3.5, and 2.5 gets no signatures', () => {
    const contents = [...req().contents, toolCallTurn([{ name: 'list_rules', args: {} }, { name: 'query_trades', args: { groupBy: [] } }]), toolResultTurn([{ call: { name: 'list_rules', args: {} }, result: {} }])];
    const on35 = buildBody(req({ contents }), 'gemini-3.5-flash-lite').contents[1].parts;
    expect(on35[0]).toMatchObject({ thoughtSignature: 'skip_thought_signature_validator' });
    expect(on35[1]).not.toHaveProperty('thoughtSignature');
    const signed = [...req().contents, toolCallTurn([{ name: 'list_rules', args: {}, thoughtSignature: 'REAL' }])];
    expect(buildBody(req({ contents: signed }), 'gemini-3.5-flash-lite').contents[1].parts[0]).toMatchObject({ thoughtSignature: 'REAL' });
    expect(buildBody(req({ contents: signed }), 'gemini-2.5-flash-lite').contents[1].parts[0]).toEqual({ functionCall: { name: 'list_rules', args: {} } });
  });

  it('stream() delivers tool calls on the end chunk and does not treat them as an empty answer', async () => {
    const f = vi.fn().mockResolvedValueOnce(sseOk([{ candidates: [{ content: { parts: [{ functionCall: { id: 'a', name: 'list_rules', args: {} }, thoughtSignature: 'S' }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 4, candidatesTokenCount: 1 } }]));
    const out = await collect(stream(req({ tools: [TOOL] }), f as any));
    expect(f).toHaveBeenCalledTimes(1);
    expect(out).toEqual([{ type: 'end', model: 'gemini-3.5-flash-lite', usage: { promptTokens: 4, outputTokens: 1 }, finishReason: 'STOP', toolCalls: [{ name: 'list_rules', args: {}, id: 'a', thoughtSignature: 'S' }] }]);
  });

  it('a malformed function call (empty, MALFORMED_FUNCTION_CALL) falls through to the next model', async () => {
    const f = vi.fn().mockResolvedValueOnce(okJson({ candidates: [{ finishReason: 'MALFORMED_FUNCTION_CALL', content: { parts: [] } }] })).mockResolvedValueOnce(answer([{ functionCall: { name: 'list_rules' } }]));
    const r = await generate(req({ tools: [TOOL] }), f as any);
    expect(r.model).toBe('gemini-2.5-flash-lite');
    expect(r.toolCalls).toEqual([{ name: 'list_rules', args: {} }]);
  });
});

describe('partial and broken streams', () => {
  const textFrame = (t: string) => ({ candidates: [{ content: { parts: [{ text: t }] } }] });

  it('a connection that breaks after text was forwarded throws AiUnavailableError (no second model)', async () => {
    const f = vi.fn().mockResolvedValueOnce(sseOk([textFrame('Half')], { failAfter: true }));
    const out: any[] = [];
    const err = await (async () => {
      for await (const c of stream(req(), f as any)) out.push(c);
    })().catch((e) => e);
    expect(out).toEqual([{ type: 'text', text: 'Half' }]);
    expect(err).toBeInstanceOf(AiUnavailableError);
    expect(err).toMatchObject({ model: 'gemini-3.5-flash-lite', status: 0 });
    expect(f).toHaveBeenCalledTimes(1);
  });

  it('a connection that breaks before any text falls back to the next model', async () => {
    const f = vi.fn().mockResolvedValueOnce(sseOk([], { failAfter: true })).mockResolvedValueOnce(sseOk([{ ...textFrame('Hi'), usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 } }]));
    const out = await collect(stream(req(), f as any));
    expect(out.map((c) => c.type)).toEqual(['text', 'end']);
    expect(out[1].model).toBe('gemini-2.5-flash-lite');
  });

  it('an error object inside the stream after text throws; before text it falls back', async () => {
    const after = vi.fn().mockResolvedValueOnce(sseOk([textFrame('Hel'), { error: { code: 500, message: 'Internal error encountered.' } }]));
    await expect(collect(stream(req(), after as any))).rejects.toMatchObject({ message: 'gemini-3.5-flash-lite Internal error encountered.', status: 200 });
    const before = vi.fn().mockResolvedValueOnce(sseOk([{ error: { code: 500, message: 'Internal error encountered.' } }])).mockResolvedValueOnce(sseOk([textFrame('ok')]));
    const out = await collect(stream(req(), before as any));
    expect(out[0]).toEqual({ type: 'text', text: 'ok' });
  });

  it('stopping the iteration cancels the response body', async () => {
    const cancel = vi.fn();
    const body = new ReadableStream({
      start(c) {
        c.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(textFrame('one'))}\n\n`));
      },
      cancel,
    });
    const f = vi.fn().mockResolvedValue({ ok: true, status: 200, body } as unknown as Response);
    for await (const c of stream(req(), f as any)) {
      expect(c).toEqual({ type: 'text', text: 'one' });
      break;
    }
    expect(cancel).toHaveBeenCalled();
  });
});

describe('provider switch', () => {
  const routerOk = () => okJson({ model: 'openai/gpt-6-luna', choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'x' } }], usage: { prompt_tokens: 1, completion_tokens: 1 } });

  it('AI_PROVIDER=gemini (any case) keeps the direct Gemini API', async () => {
    for (const v of ['gemini', ' GEMINI ']) {
      process.env.AI_PROVIDER = v;
      process.env.OPENROUTER_API_KEY_PARAM = '/test/openrouter';
      const f = vi.fn().mockResolvedValue(answer([{ text: 'x' }]));
      await generate(req(), f as any);
      expect(f.mock.calls[0][0]).toContain('generativelanguage.googleapis.com');
      expect(f.mock.calls[0][1].headers['x-goog-api-key']).toBe('key-for-/test/gemini');
    }
    expect(ssmNames).toEqual(['/test/gemini']);
  });

  it('defaults to OpenRouter: AI_PROVIDER openrouter, unset, empty or unknown (e.g. the retired "openai")', async () => {
    process.env.OPENROUTER_API_KEY_PARAM = '/test/openrouter';
    for (const v of ['openrouter', undefined, '', 'openai']) {
      if (v === undefined) delete process.env.AI_PROVIDER;
      else process.env.AI_PROVIDER = v;
      const f = vi.fn().mockResolvedValue(routerOk());
      const r = await generate(req(), f as any);
      expect(f.mock.calls[0][0]).toBe('https://openrouter.ai/api/v1/chat/completions');
      expect(f.mock.calls[0][1].headers.Authorization).toBe('Bearer key-for-/test/openrouter');
      expect(r.model).toBe('openai/gpt-6-luna');
    }
    expect(ssmNames).toEqual(['/test/openrouter']);
  });

  it('with AI_PROVIDER unset, a function configured only with GEMINI_API_KEY_PARAM stays on Gemini', async () => {
    delete process.env.AI_PROVIDER;
    const f = vi.fn().mockResolvedValue(answer([{ text: 'x' }]));
    await generate(req(), f as any);
    expect(f.mock.calls[0][0]).toContain('generativelanguage.googleapis.com');
  });

  it('openrouter without OPENROUTER_API_KEY_PARAM is AiUnavailableError, before any request', async () => {
    process.env.AI_PROVIDER = 'openrouter';
    const f = vi.fn();
    const err = await generate(req(), f as any).catch((e) => e);
    expect(err).toBeInstanceOf(AiUnavailableError);
    expect(err.message).toBe('OPENROUTER_API_KEY_PARAM not configured');
    expect(f).not.toHaveBeenCalled();
  });
});
