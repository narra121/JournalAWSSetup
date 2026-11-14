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

import { AiUnavailableError, generate, stream, toolCallTurn, toolResultTurn, type GeminiRequest } from '../gemini';
import { buildOpenRouterBody, dropAddedNulls, OPENROUTER_MODELS, toMessages, toStrictSchema, __resetOpenRouterKeyCache } from '../openrouter';
import { reviewSchema } from '../../insights/prompt';
import { reviewOf } from '../../insights/__tests__/fixtures';
import { generateText, GeminiHttpError, __resetSharedAiKeyCache } from '../../../shared/gemini';

const okJson = (body: unknown) => ({ ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) }) as unknown as Response;
const fail = (status: number, body = 'err') => ({ ok: false, status, statusText: 'x', text: async () => body, json: async () => ({}) }) as unknown as Response;
const completion = (message: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
  okJson({ id: 'gen-1', model: 'openai/gpt-6-luna', choices: [{ index: 0, finish_reason: 'stop', native_finish_reason: 'completed', message: { role: 'assistant', ...message } }], usage: { prompt_tokens: 12, completion_tokens: 4, cost: 0.00021 }, ...extra });
/** Raw SSE wire text, delivered in reads of `size` characters (frames and JSON split anywhere). */
const sseWire = (wire: string, opts: { size?: number; failAfter?: boolean } = {}) => {
  const enc = new TextEncoder();
  const size = opts.size ?? wire.length;
  const queue: Uint8Array[] = [];
  for (let i = 0; i < wire.length; i += size) queue.push(enc.encode(wire.slice(i, i + size)));
  return {
    ok: true,
    status: 200,
    body: new ReadableStream({
      pull(c) {
        const next = queue.shift();
        if (next) c.enqueue(next);
        else if (opts.failAfter) c.error(new Error('socket hang up'));
        else c.close();
      },
    }),
  } as unknown as Response;
};
const frame = (data: unknown) => `data: ${typeof data === 'string' ? data : JSON.stringify(data)}\n\n`;
const chunk = (delta: Record<string, unknown>, extra: Record<string, unknown> = {}) => frame({ id: 'gen-2', object: 'chat.completion.chunk', model: 'openai/gpt-6-luna', choices: [{ index: 0, delta, finish_reason: null, ...extra }] });
const finishChunk = (reason: string, usage = { prompt_tokens: 5, completion_tokens: 2, cost: 0.0001 }) =>
  frame({ id: 'gen-2', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { content: '' }, finish_reason: reason }], usage });
const req = (extra: Partial<GeminiRequest> = {}): GeminiRequest => ({ system: 'sys', contents: [{ role: 'user', parts: [{ text: 'q' }] }], temperature: 0.3, maxOutputTokens: 50, ...extra });
const collect = async (it: AsyncGenerator<any>) => {
  const out = [];
  for await (const c of it) out.push(c);
  return out;
};
const sentBody = (f: any, i = 0) => JSON.parse(f.mock.calls[i][1].body);

const TOOL = {
  name: 'stats',
  description: 'Per-setup totals',
  parameters: {
    type: 'object',
    properties: { groupBy: { type: 'string', enum: ['setup', 'symbol'] }, from: { type: 'string', description: 'YYYY-MM-DD' } },
    required: ['groupBy'],
  },
};

beforeEach(() => {
  __resetOpenRouterKeyCache();
  __resetSharedAiKeyCache();
  ssmNames.length = 0;
  process.env.AI_PROVIDER = 'openrouter';
  process.env.OPENROUTER_API_KEY_PARAM = '/tradequt/openrouterApiKey';
});
afterEach(() => {
  delete process.env.AI_PROVIDER;
  delete process.env.OPENROUTER_API_KEY_PARAM;
  vi.unstubAllGlobals();
});

describe('request shape', () => {
  it('models per purpose: report gpt-6.1-terra, chat gpt-6-luna, extract gemini-3.5-flash-lite only', async () => {
    expect(OPENROUTER_MODELS).toEqual({
      report: ['openai/gpt-6.1-terra'],
      chat: ['openai/gpt-6-luna'],
      extract: ['google/gemini-3.5-flash-lite'],
    });
    for (const [purpose, model] of [[undefined, 'openai/gpt-6-luna'], ['chat', 'openai/gpt-6-luna'], ['report', 'openai/gpt-6.1-terra'], ['extract', 'google/gemini-3.5-flash-lite']] as const) {
      const f = vi.fn().mockResolvedValue(completion({ content: 'x' }));
      const r = await generate(req({ purpose }), f as any);
      expect(r.model).toBe(model);
      expect(sentBody(f).model).toBe(model);
    }
  });

  it('POSTs to chat/completions with the SSM key, attribution headers, data_collection deny and no thinking on Gemini', async () => {
    const f = vi.fn().mockResolvedValue(completion({ content: 'hi' }));
    await generate(req({ purpose: 'report' }), f as any);
    const [url, init] = f.mock.calls[0];
    expect(url).toBe('https://openrouter.ai/api/v1/chat/completions');
    expect(init.method).toBe('POST');
    expect(init.headers).toEqual({ 'Content-Type': 'application/json', Authorization: 'Bearer key-for-/tradequt/openrouterApiKey', 'HTTP-Referer': 'https://tradequt.com', 'X-Title': 'TradeQut' });
    expect(sentBody(f)).toEqual({
      model: 'openai/gpt-6.1-terra',
      messages: [{ role: 'system', content: 'sys' }, { role: 'user', content: 'q' }],
      temperature: 0.3,
      max_tokens: 50,
      reasoning: { effort: 'none' },
      provider: { data_collection: 'deny' },
    });
    expect(ssmNames).toEqual(['/tradequt/openrouterApiKey']);
    const g = vi.fn().mockResolvedValue(completion({ content: 'hi' }));
    await generate(req({ purpose: 'extract' }), g as any);
    expect(sentBody(g).provider).toEqual({ data_collection: 'deny' });
    expect(JSON.stringify(sentBody(g))).not.toMatch(/reasoning|thinking/i);
    expect(ssmNames).toHaveLength(1);
  });

  it('every request, streamed or not and with tools or a schema, carries data_collection deny', () => {
    for (const stream of [false, true]) {
      for (const extra of [{}, { tools: [TOOL] }, { responseSchema: { type: 'OBJECT', properties: { a: { type: 'STRING' } } } }]) {
        const b = buildOpenRouterBody('openai/gpt-6-luna', req(extra), stream);
        expect(b.provider).toEqual({ data_collection: 'deny' });
        expect(b.stream).toBe(stream ? true : undefined);
      }
    }
  });

  it('image parts become image_url data URLs after the text of the same user message', () => {
    const msgs = toMessages('', [{ role: 'user', parts: [{ inlineData: { mimeType: 'image/png', data: 'AAAA' } }, { text: 'Extract the trades.' }] }]);
    expect(msgs).toEqual([{ role: 'user', content: [{ type: 'text', text: 'Extract the trades.' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }] }]);
  });

  it('a model turn with text keeps it as assistant content; thought parts are dropped', () => {
    expect(toMessages('s', [{ role: 'model', parts: [{ text: 'thinking', thought: true }, { text: 'Hello' }] }, { role: 'user', parts: [{ text: 'more' }] }])).toEqual([
      { role: 'system', content: 's' },
      { role: 'assistant', content: 'Hello' },
      { role: 'user', content: 'more' },
    ]);
  });
});

describe('strict JSON schema', () => {
  it('response_format is json_schema strict, translated from the Gemini dialect (the weekly review schema)', () => {
    const schema = reviewSchema(reviewOf([]));
    const b = buildOpenRouterBody('openai/gpt-6.1-terra', req({ responseSchema: schema }), false) as any;
    expect(b.response_format).toMatchObject({ type: 'json_schema', json_schema: { name: 'response', strict: true } });
    const walk = (s: any): void => {
      if (s?.type === 'object' || (Array.isArray(s?.type) && s.type.includes('object'))) {
        expect(s.additionalProperties).toBe(false);
        expect([...s.required].sort()).toEqual(Object.keys(s.properties).sort());
        Object.values(s.properties).forEach(walk);
      }
      if (s?.items) walk(s.items);
      expect(typeof s.type === 'string' ? s.type : 'x').toBe(typeof s.type === 'string' ? s.type.toLowerCase() : 'x');
    };
    walk(b.response_format.json_schema.schema);
  });

  it('optional properties become nullable and the added nulls are dropped from the reply', async () => {
    const schema = { type: 'OBJECT', required: ['a'], properties: { a: { type: 'STRING' }, b: { type: 'STRING', enum: ['x', 'y'] }, c: { type: 'STRING', nullable: true } } };
    expect(toStrictSchema(schema)).toEqual({
      type: 'object',
      properties: { a: { type: 'string' }, b: { type: ['string', 'null'], enum: ['x', 'y', null] }, c: { type: ['string', 'null'] } },
      required: ['a', 'b', 'c'],
      additionalProperties: false,
    });
    const f = vi.fn().mockResolvedValue(completion({ content: '{"a":"1","b":null,"c":null}' }));
    const r = await generate(req({ responseSchema: schema, purpose: 'report' }), f as any);
    expect(JSON.parse(r.text)).toEqual({ a: '1', c: null });
    expect(dropAddedNulls([{ a: '1', b: null }], { type: 'array', items: schema })).toEqual([{ a: '1' }]);
  });
});

describe('tools', () => {
  it('tools are strict functions; tool_calls come back parsed with their ids, and usage includes cost', async () => {
    const f = vi.fn().mockResolvedValue(
      completion({ content: null, tool_calls: [{ id: 'call_a', type: 'function', function: { name: 'stats', arguments: '{"groupBy":"setup","from":null}' } }] }, { choices: [{ index: 0, finish_reason: 'tool_calls', message: { role: 'assistant', content: null, tool_calls: [{ id: 'call_a', type: 'function', function: { name: 'stats', arguments: '{"groupBy":"setup","from":null}' } }] } }] }),
    );
    const r = await generate(req({ tools: [TOOL] }), f as any);
    expect(sentBody(f).tools).toEqual([
      {
        type: 'function',
        function: {
          name: 'stats',
          description: 'Per-setup totals',
          strict: true,
          parameters: { type: 'object', properties: { groupBy: { type: 'string', enum: ['setup', 'symbol'] }, from: { type: ['string', 'null'], description: 'YYYY-MM-DD' } }, required: ['groupBy', 'from'], additionalProperties: false },
        },
      },
    ]);
    expect(r).toEqual({ text: '', model: 'openai/gpt-6-luna', usage: { promptTokens: 12, outputTokens: 4, cost: 0.00021 }, toolCalls: [{ name: 'stats', args: { groupBy: 'setup' }, id: 'call_a' }], finishReason: 'STOP' });
  });

  it('the round trip sends the assistant tool_calls and one tool message per result, then the tools again', async () => {
    const calls = [{ name: 'stats', args: { groupBy: 'setup' }, id: 'call_a' }, { name: 'stats', args: { groupBy: 'symbol' }, id: 'call_b' }];
    const contents = [...req().contents, toolCallTurn(calls), toolResultTurn([{ call: calls[0], result: { rows: [['Breakout', 3]] } }, { call: calls[1], result: 7 }])];
    const f = vi.fn().mockResolvedValue(completion({ content: 'Breakout made the most.' }));
    const r = await generate(req({ contents, tools: [TOOL] }), f as any);
    expect(r.text).toBe('Breakout made the most.');
    const body = sentBody(f);
    expect(body.messages.slice(1)).toEqual([
      { role: 'user', content: 'q' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          { id: 'call_a', type: 'function', function: { name: 'stats', arguments: '{"groupBy":"setup"}' } },
          { id: 'call_b', type: 'function', function: { name: 'stats', arguments: '{"groupBy":"symbol"}' } },
        ],
      },
      { role: 'tool', tool_call_id: 'call_a', content: '{"rows":[["Breakout",3]]}' },
      { role: 'tool', tool_call_id: 'call_b', content: '{"result":7}' },
    ]);
    expect(body.tools).toHaveLength(1);
  });

  it('calls without ids get call_<n> and results are paired with the oldest unanswered call of that name', () => {
    const msgs: any[] = toMessages('', [
      { role: 'model', parts: [{ functionCall: { name: 'stats', args: {} } }, { functionCall: { name: 'stats', args: { x: 1 } } }] },
      { role: 'user', parts: [{ functionResponse: { name: 'stats', response: { a: 1 } } }, { functionResponse: { name: 'stats', response: { a: 2 } } }] },
    ]);
    expect(msgs[0].tool_calls.map((c: any) => c.id)).toEqual(['call_0', 'call_1']);
    expect(msgs.slice(1).map((m) => m.tool_call_id)).toEqual(['call_0', 'call_1']);
  });

  it('malformed tool arguments are a failed attempt, not a call', async () => {
    const f = vi.fn().mockResolvedValue(completion({ content: null, tool_calls: [{ id: 'c', type: 'function', function: { name: 'stats', arguments: '{"groupBy":' } }] }));
    const err = await generate(req({ tools: [TOOL] }), f as any).catch((e) => e);
    expect(err).toBeInstanceOf(AiUnavailableError);
    expect(err.message).toBe('openai/gpt-6-luna malformed arguments for stats');
  });
});

describe('errors and fallback', () => {
  it('402 (no credits) is AiUnavailableError with status 402 and is not retried', async () => {
    const body = JSON.stringify({ error: { code: 402, message: 'Insufficient credits. Add more using https://openrouter.ai/settings/credits' } });
    const f = vi.fn().mockResolvedValue(fail(402, body));
    const err = await generate(req({ purpose: 'extract' }), f as any).catch((e) => e);
    expect(err).toBeInstanceOf(AiUnavailableError);
    expect(err).toMatchObject({ model: 'google/gemini-3.5-flash-lite', status: 402 });
    expect(err.message).toContain('Insufficient credits');
    expect(f).toHaveBeenCalledTimes(1);
    const s = vi.fn().mockResolvedValue(fail(402, body));
    await expect(collect(stream(req(), s as any))).rejects.toMatchObject({ status: 402 });
  });

  it('429 and 503 (no provider meets the data policy) on the only extract model fail after one call', async () => {
    const f = vi.fn().mockResolvedValue(fail(429));
    await expect(generate(req({ purpose: 'extract' }), f as any)).rejects.toMatchObject({ status: 429, model: 'google/gemini-3.5-flash-lite' });
    expect(f).toHaveBeenCalledTimes(1);
    const g = vi.fn().mockResolvedValue(fail(503));
    await expect(generate(req({ purpose: 'extract' }), g as any)).rejects.toMatchObject({ status: 503, model: 'google/gemini-3.5-flash-lite' });
    expect(g).toHaveBeenCalledTimes(1);
  });

  it('a 200 that carries an error object (and no choices) is a failure, not an empty answer', async () => {
    const f = vi.fn().mockResolvedValue(okJson({ error: { code: 502, message: 'Provider returned error' } }));
    const err = await generate(req(), f as any).catch((e) => e);
    expect(err).toMatchObject({ status: 200, message: 'openai/gpt-6-luna error 502 Provider returned error' });
  });

  it('a refusal counts as no answer; finish_reason length maps to MAX_TOKENS', async () => {
    const f = vi.fn().mockResolvedValue(completion({ content: null, refusal: 'I cannot help with that.' }));
    await expect(generate(req(), f as any)).rejects.toMatchObject({ message: expect.stringContaining('empty response (SAFETY)') });
    const g = vi.fn().mockResolvedValue(okJson({ choices: [{ finish_reason: 'length', message: { content: 'cut' } }] }));
    expect((await generate(req(), g as any)).finishReason).toBe('MAX_TOKENS');
  });

  it('an aborted caller signal stops before any request', async () => {
    const ac = new AbortController();
    ac.abort();
    const f = vi.fn();
    await expect(generate(req({ signal: ac.signal }), f as any)).rejects.toThrow('Request aborted');
    expect(f).not.toHaveBeenCalled();
  });

  it('the caller signal reaches fetch', async () => {
    const ac = new AbortController();
    const f = vi.fn().mockResolvedValue(completion({ content: 'x' }));
    await generate(req({ signal: ac.signal }), f as any);
    const sent: AbortSignal = f.mock.calls[0][1].signal;
    expect(sent.aborted).toBe(false);
    ac.abort();
    expect(sent.aborted).toBe(true);
  });
});

describe('stream parser', () => {
  it('ignores keep-alive comments, joins text split at every byte, reads usage with cost and stops at [DONE]', async () => {
    const wire = ': OPENROUTER PROCESSING\n\n' + chunk({ role: 'assistant', content: 'Net P&L ' }) + ': OPENROUTER PROCESSING\n\n' + chunk({ content: 'is 52.00.' }) + finishChunk('stop') + frame('[DONE]');
    const f = vi.fn().mockResolvedValue(sseWire(wire, { size: 1 }));
    const out = await collect(stream(req(), f as any));
    expect(out.filter((c) => c.type === 'text').map((c) => c.text).join('')).toBe('Net P&L is 52.00.');
    expect(out.at(-1)).toEqual({ type: 'end', model: 'openai/gpt-6-luna', usage: { promptTokens: 5, outputTokens: 2, cost: 0.0001 }, finishReason: 'STOP' });
    expect(sentBody(f).stream).toBe(true);
  });

  it('assembles tool_call deltas: id and name once, arguments in fragments across chunks, two calls by index', async () => {
    const wire =
      chunk({ role: 'assistant', content: null, tool_calls: [{ index: 0, id: 'call_a', type: 'function', function: { name: 'stats', arguments: '' } }] }) +
      chunk({ tool_calls: [{ index: 0, function: { arguments: '{"group' } }] }) +
      chunk({ tool_calls: [{ index: 1, id: 'call_b', type: 'function', function: { name: 'stats', arguments: '{"groupBy":' } }] }) +
      chunk({ tool_calls: [{ index: 0, function: { arguments: 'By":"setup"}' } }] }) +
      chunk({ tool_calls: [{ index: 1, function: { arguments: '"symbol","from":null}' } }] }) +
      finishChunk('tool_calls') +
      frame('[DONE]');
    const f = vi.fn().mockResolvedValue(sseWire(wire, { size: 7 }));
    const out = await collect(stream(req({ tools: [TOOL] }), f as any));
    expect(out).toEqual([
      {
        type: 'end',
        model: 'openai/gpt-6-luna',
        usage: { promptTokens: 5, outputTokens: 2, cost: 0.0001 },
        finishReason: 'STOP',
        toolCalls: [
          { name: 'stats', args: { groupBy: 'setup' }, id: 'call_a' },
          { name: 'stats', args: { groupBy: 'symbol' }, id: 'call_b' },
        ],
      },
    ]);
  });

  it('an error object inside a 200 stream throws AiUnavailableError, after text and before it (no other model to try)', async () => {
    const midError = frame({ id: 'gen-3', object: 'chat.completion.chunk', error: { code: 502, message: 'Provider disconnected unexpectedly' }, choices: [{ index: 0, delta: { content: '' }, finish_reason: 'error' }] });
    const after = vi.fn().mockResolvedValue(sseWire(chunk({ content: 'Hel' }) + midError));
    const out: any[] = [];
    const err = await (async () => {
      for await (const c of stream(req(), after as any)) out.push(c);
    })().catch((e) => e);
    expect(out).toEqual([{ type: 'text', text: 'Hel' }]);
    expect(err).toBeInstanceOf(AiUnavailableError);
    expect(err).toMatchObject({ message: 'openai/gpt-6-luna error 502 Provider disconnected unexpectedly', status: 200 });
    const before = vi.fn().mockResolvedValue(sseWire(midError));
    const early = await collect(stream(req({ purpose: 'extract' }), before as any)).catch((e) => e);
    expect(early).toBeInstanceOf(AiUnavailableError);
    expect(early).toMatchObject({ model: 'google/gemini-3.5-flash-lite', status: 200 });
    expect(before).toHaveBeenCalledTimes(1);
  });

  it('a stream that ends without finish_reason or [DONE] after text is cut off; a broken connection is status 0', async () => {
    const cut = vi.fn().mockResolvedValue(sseWire(chunk({ content: 'Half' })));
    await expect(collect(stream(req(), cut as any))).rejects.toMatchObject({ message: 'openai/gpt-6-luna stream ended before the response was complete', status: 200 });
    const broken = vi.fn().mockResolvedValue(sseWire(chunk({ content: 'Half' }), { failAfter: true }));
    await expect(collect(stream(req(), broken as any))).rejects.toMatchObject({ status: 0 });
  });

  it('finish_reason length ends the stream with MAX_TOKENS; malformed streamed arguments fail', async () => {
    const f = vi.fn().mockResolvedValue(sseWire(chunk({ content: 'cut' }) + finishChunk('length') + frame('[DONE]')));
    expect((await collect(stream(req(), f as any))).at(-1).finishReason).toBe('MAX_TOKENS');
    const g = vi.fn().mockResolvedValue(sseWire(chunk({ tool_calls: [{ index: 0, id: 'c', function: { name: 'stats', arguments: '{"groupBy"' } }] }) + finishChunk('tool_calls') + frame('[DONE]')));
    await expect(collect(stream(req({ tools: [TOOL] }), g as any))).rejects.toMatchObject({ message: 'openai/gpt-6-luna malformed arguments for stats' });
  });

  it('stopping the iteration cancels the response body', async () => {
    const cancel = vi.fn();
    const body = new ReadableStream({
      start(c) {
        c.enqueue(new TextEncoder().encode(chunk({ content: 'one' })));
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

describe('shared generateText (extraction, enhance-text) via OpenRouter', () => {
  const parts = [{ text: 'Extract trades' }, { inlineData: { mimeType: 'image/jpeg', data: 'QUJD' } }];
  const call = () => generateText({ parts, maxOutputTokens: 4096, temperature: 0, timeoutMs: 5000 });

  it('sends the image as a data URL to gemini-3.5-flash-lite with data_collection deny and maps finish_reason', async () => {
    const f = vi.fn().mockResolvedValue(completion({ content: ' symbol,side \n' }));
    vi.stubGlobal('fetch', f);
    expect(await call()).toEqual({ text: 'symbol,side', finishReason: 'STOP', model: 'google/gemini-3.5-flash-lite' });
    const [url, init] = f.mock.calls[0];
    expect(url).toBe('https://openrouter.ai/api/v1/chat/completions');
    expect(init.headers).toMatchObject({ Authorization: 'Bearer key-for-/tradequt/openrouterApiKey', 'HTTP-Referer': 'https://tradequt.com', 'X-Title': 'TradeQut' });
    expect(JSON.parse(init.body)).toEqual({
      model: 'google/gemini-3.5-flash-lite',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'Extract trades' }, { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,QUJD' } }] }],
      temperature: 0,
      max_tokens: 4096,
      provider: { data_collection: 'deny' },
    });
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it('429 or an empty answer from the only model fails after one call; length maps to MAX_TOKENS', async () => {
    const f = vi.fn().mockResolvedValue(okJson({ choices: [{ finish_reason: 'length', message: { content: 'part' } }] }));
    vi.stubGlobal('fetch', f);
    expect(await call()).toEqual({ text: 'part', finishReason: 'MAX_TOKENS', model: 'google/gemini-3.5-flash-lite' });
    const r = vi.fn().mockResolvedValue(fail(429));
    vi.stubGlobal('fetch', r);
    await expect(call()).rejects.toMatchObject({ status: 429 });
    expect(r).toHaveBeenCalledTimes(1);
    const g = vi.fn().mockResolvedValue(completion({ content: '' }));
    vi.stubGlobal('fetch', g);
    await expect(call()).rejects.toThrow('Gemini returned empty response');
    expect(g).toHaveBeenCalledTimes(1);
  });

  it('402 throws GeminiHttpError without a fallback; a 200 error body is an empty response', async () => {
    const f = vi.fn().mockResolvedValue(fail(402, '{"error":{"code":402,"message":"Insufficient credits"}}'));
    vi.stubGlobal('fetch', f);
    const err = await call().catch((e) => e);
    expect(err).toBeInstanceOf(GeminiHttpError);
    expect(err.status).toBe(402);
    expect(f).toHaveBeenCalledTimes(1);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(okJson({ error: { code: 502, message: 'Provider returned error' } })));
    await expect(call()).rejects.toThrow('Gemini returned empty response');
  });

  it('AI_PROVIDER=gemini keeps the direct generateContent call', async () => {
    process.env.AI_PROVIDER = 'gemini';
    process.env.GEMINI_API_KEY_PARAM = '/test/gemini';
    const f = vi.fn().mockResolvedValue(okJson({ candidates: [{ content: { parts: [{ text: 'ok' }] }, finishReason: 'STOP' }] }));
    vi.stubGlobal('fetch', f);
    expect(await call()).toEqual({ text: 'ok', finishReason: 'STOP', model: 'gemini-2.5-flash-lite' });
    expect(f.mock.calls[0][0]).toBe('https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:generateContent');
    expect(JSON.parse(f.mock.calls[0][1].body).contents[0].parts).toEqual(parts);
    delete process.env.GEMINI_API_KEY_PARAM;
  });

  it('a missing OPENROUTER_API_KEY_PARAM fails before any request', async () => {
    delete process.env.OPENROUTER_API_KEY_PARAM;
    const f = vi.fn();
    vi.stubGlobal('fetch', f);
    await expect(call()).rejects.toThrow('Missing OPENROUTER_API_KEY_PARAM');
    expect(f).not.toHaveBeenCalled();
  });
});
