import { ssmKey, type AiPurpose, type GeminiContent, type GeminiRequest, type GeminiUsage, type JsonSchema, type ToolCall } from './core';
import type { Parsed, Provider, StreamState } from './runner';

export const OPENROUTER_CHAT_URL = 'https://openrouter.ai/api/v1/chat/completions';
/** App attribution headers OpenRouter recommends (api-reference overview). */
export const OPENROUTER_HEADERS = { 'HTTP-Referer': 'https://tradequt.com', 'X-Title': 'TradeQut' } as const;
/** Sent on every OpenRouter request (here and shared/gemini.ts): route only to providers that do not store or train on prompts. */
export const OPENROUTER_PROVIDER = { data_collection: 'deny' } as const;

/** OpenRouter's normalized `finish_reason` in the Gemini vocabulary callers check (enhance-text wants "STOP"). */
export function geminiFinishReason(finish: unknown): string | undefined {
  if (typeof finish !== 'string' || !finish) return undefined;
  const map: Record<string, string> = { stop: 'STOP', tool_calls: 'STOP', length: 'MAX_TOKENS', content_filter: 'SAFETY' };
  return map[finish] ?? finish.toUpperCase();
}

/**
 * OpenRouter model ids, tried in order by the runner (same deadline and fall-through rules as Gemini). The runner's
 * fallback is used instead of OpenRouter's `models` array because OpenRouter falls back only on provider errors, not
 * on an empty or unusable answer or a stream that breaks before its first token.
 */
export const OPENROUTER_MODELS: Record<AiPurpose, readonly string[]> = {
  report: ['openai/gpt-6.1-terra'],
  chat: ['openai/gpt-6-luna'],
  extract: ['google/gemini-3.5-flash-lite'],
};

const openRouterKey = ssmKey('OPENROUTER_API_KEY_PARAM', 'OpenRouter');
export const getOpenRouterKey = openRouterKey.get;

const isObj = (v: unknown): v is JsonSchema => typeof v === 'object' && v !== null && !Array.isArray(v);
/** Keywords OpenAI strict Structured Outputs accepts (OpenAI structured-outputs guide, "Supported schemas"). */
const COPIED = ['description', 'enum', 'const', 'minItems', 'maxItems', 'minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf', 'pattern', '$ref'];
const FORMATS = new Set(['date-time', 'time', 'date', 'duration', 'email', 'hostname', 'ipv4', 'ipv6', 'uuid']);

function strict(schema: unknown, optional: boolean): unknown {
  if (!isObj(schema)) return schema;
  const out: JsonSchema = {};
  const raw = schema.type;
  let types = (Array.isArray(raw) ? raw : typeof raw === 'string' ? [raw] : []).map((t) => String(t).toLowerCase());
  const nullable = optional || schema.nullable === true;
  for (const k of COPIED) if (schema[k] !== undefined) out[k] = schema[k];
  if (typeof schema.format === 'string' && FORMATS.has(schema.format)) out.format = schema.format;
  if (isObj(schema.$defs)) out.$defs = Object.fromEntries(Object.entries(schema.$defs).map(([k, v]) => [k, strict(v, false)]));
  if (types.includes('object') || isObj(schema.properties)) {
    const props = isObj(schema.properties) ? schema.properties : {};
    const required = new Set(Array.isArray(schema.required) ? schema.required : []);
    out.properties = Object.fromEntries(Object.entries(props).map(([k, v]) => [k, strict(v, !required.has(k))]));
    out.required = Object.keys(props);
    out.additionalProperties = false;
    if (!types.length) types = ['object'];
  }
  if (schema.items !== undefined) out.items = strict(schema.items, false);
  if (Array.isArray(schema.anyOf)) {
    const branches = schema.anyOf.map((b) => strict(b, false));
    out.anyOf = nullable && !branches.some((b) => isObj(b) && b.type === 'null') ? [...branches, { type: 'null' }] : branches;
  } else if (types.length) {
    if (nullable && !types.includes('null')) types.push('null');
    out.type = types.length === 1 ? types[0] : types;
  }
  if (nullable && Array.isArray(out.enum) && !out.enum.includes(null)) out.enum = [...out.enum, null];
  return out;
}

/**
 * JSON Schema or the Gemini dialect to strict mode: every property required, `additionalProperties: false`;
 * a property that was optional becomes nullable (the null is removed again from the reply, see `dropAddedNulls`).
 */
export function toStrictSchema(schema: unknown): JsonSchema {
  const out = strict(isObj(schema) && schema.type === undefined && !schema.anyOf ? { ...schema, type: 'object' } : schema, false);
  return isObj(out) ? out : { type: 'object', properties: {}, required: [], additionalProperties: false };
}

const allowsNull = (s: unknown) =>
  isObj(s) && (s.nullable === true || s.type === 'null' || (Array.isArray(s.type) && s.type.includes('null')) || (Array.isArray(s.anyOf) && s.anyOf.some((b) => isObj(b) && b.type === 'null')));

/** Removes the nulls strict mode puts in properties the original schema left optional, so replies match it. */
export function dropAddedNulls(value: unknown, schema: unknown): unknown {
  if (!isObj(schema)) return value;
  if (Array.isArray(value)) return value.map((v) => dropAddedNulls(v, schema.items));
  if (!isObj(value) || !isObj(schema.properties)) return value;
  const props = schema.properties;
  const required = new Set(Array.isArray(schema.required) ? schema.required : []);
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) {
    if (v === null && !required.has(k) && !allowsNull(props[k])) continue;
    out[k] = dropAddedNulls(v, props[k]);
  }
  return out;
}

/**
 * Chat Completions messages. A model turn becomes one assistant message (text + `tool_calls`); a user turn's
 * function responses become `tool` messages, which must directly follow that assistant message, then its text and
 * images one user message. A call without an id gets `call_<n>`; a result without an id takes the oldest unanswered
 * call of the same name.
 */
export function toMessages(system: string, contents: GeminiContent[]): unknown[] {
  const messages: unknown[] = system ? [{ role: 'system', content: system }] : [];
  const open = new Map<string, string[]>();
  let n = 0;
  for (const c of contents) {
    const text = c.parts.map((p) => (typeof p.text === 'string' && !('thought' in p && p.thought) ? p.text : '')).join('');
    if (c.role === 'model') {
      const toolCalls = c.parts.flatMap((p) => {
        if (!('functionCall' in p)) return [];
        const id = p.functionCall.id ?? `call_${n++}`;
        open.set(p.functionCall.name, [...(open.get(p.functionCall.name) ?? []), id]);
        return [{ id, type: 'function', function: { name: p.functionCall.name, arguments: JSON.stringify(p.functionCall.args ?? {}) } }];
      });
      if (text || toolCalls.length) messages.push({ role: 'assistant', content: text || null, ...(toolCalls.length ? { tool_calls: toolCalls } : {}) });
      continue;
    }
    for (const p of c.parts) {
      if (!('functionResponse' in p)) continue;
      const { name, id: given, response } = p.functionResponse;
      const pending = open.get(name) ?? [];
      const id = given ?? pending[0] ?? `call_${n++}`;
      open.set(name, pending.filter((x) => x !== id));
      messages.push({ role: 'tool', tool_call_id: id, content: JSON.stringify(response) });
    }
    const images = c.parts.flatMap((p) => ('inlineData' in p ? [{ type: 'image_url', image_url: { url: `data:${p.inlineData.mimeType};base64,${p.inlineData.data}` } }] : []));
    if (images.length) messages.push({ role: 'user', content: [...(text ? [{ type: 'text', text }] : []), ...images] });
    else if (text) messages.push({ role: 'user', content: text });
  }
  return messages;
}

/** No reasoning on OpenAI models: it would spend the `max_tokens` budget before the answer. Gemini models get no setting (CONTRACT I5). */
const reasoningFor = (model: string) => (model.startsWith('openai/') ? { reasoning: { effort: 'none' } } : {});

export function buildOpenRouterBody(model: string, req: GeminiRequest, stream: boolean) {
  return {
    model,
    messages: toMessages(req.system, req.contents),
    temperature: req.temperature,
    max_tokens: req.maxOutputTokens,
    ...reasoningFor(model),
    provider: OPENROUTER_PROVIDER,
    ...(req.responseSchema ? { response_format: { type: 'json_schema', json_schema: { name: 'response', strict: true, schema: toStrictSchema(req.responseSchema) } } } : {}),
    ...(req.tools?.length
      ? { tools: req.tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: toStrictSchema(t.parameters), strict: true } })) }
      : {}),
    ...(stream ? { stream: true } : {}),
  };
}

const usageOf = (u: any): GeminiUsage => ({
  promptTokens: u?.prompt_tokens ?? 0,
  outputTokens: u?.completion_tokens ?? 0,
  ...(typeof u?.cost === 'number' ? { cost: u.cost } : {}),
});

const errorText = (e: any) => `error ${e?.code ?? ''} ${String(e?.message ?? 'provider error')}`.replace(/\s+/g, ' ').trim().slice(0, 200);

/** Arguments arrive as a JSON string; a malformed one yields `failure` instead of a call. */
function toolCall(id: unknown, name: string, args: string, req: GeminiRequest): ToolCall | string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(args || '{}');
  } catch {
    return `malformed arguments for ${name}`;
  }
  const decl = req.tools?.find((t) => t.name === name);
  const clean = decl ? dropAddedNulls(parsed, decl.parameters) : parsed;
  return { name, args: isObj(clean) ? clean : {}, ...(typeof id === 'string' && id ? { id } : {}) };
}

/** JSON replies lose the nulls added for strict mode; truncated JSON is passed on as it came. */
function cleanJson(text: string, req: GeminiRequest): string {
  if (!req.responseSchema || !text) return text;
  try {
    return JSON.stringify(dropAddedNulls(JSON.parse(text), req.responseSchema));
  } catch {
    return text;
  }
}

const contentText = (raw: unknown): string =>
  typeof raw === 'string' ? raw : Array.isArray(raw) ? raw.map((c: any) => (typeof c?.text === 'string' ? c.text : '')).join('') : '';

/** A refusal counts as no answer, like a Gemini safety block; `finish_reason: "error"` and an `error` object are failures. */
function parseCompletion(data: any, req: GeminiRequest): Parsed {
  const choice = data?.choices?.[0];
  const message = choice?.message;
  const refused = typeof message?.refusal === 'string' && message.refusal.length > 0;
  let failure: string | undefined;
  const toolCalls: ToolCall[] = [];
  for (const tc of Array.isArray(message?.tool_calls) ? message.tool_calls : []) {
    if (typeof tc?.function?.name !== 'string') continue;
    const call = toolCall(tc.id, tc.function.name, typeof tc.function.arguments === 'string' ? tc.function.arguments : JSON.stringify(tc.function.arguments ?? {}), req);
    if (typeof call === 'string') failure = call;
    else toolCalls.push(call);
  }
  const error = data?.error ?? choice?.error;
  if (error) failure = errorText(error);
  else if (choice?.finish_reason === 'error') failure = 'error finish_reason';
  return {
    text: refused ? '' : cleanJson(contentText(message?.content), req),
    toolCalls,
    usage: usageOf(data?.usage),
    finishReason: refused ? 'SAFETY' : geminiFinishReason(choice?.finish_reason),
    failure,
  };
}

/** Streamed tool calls arrive as fragments keyed by `index`; `id` and `name` come once, `arguments` in pieces. */
interface CallBuffer {
  id?: string;
  name: string;
  args: string;
}

function streamState(req: GeminiRequest): StreamState {
  let usage: GeminiUsage = { promptTokens: 0, outputTokens: 0 };
  let finish: string | undefined;
  let failure: string | undefined;
  let done = false;
  let refused = false;
  const calls: CallBuffer[] = [];
  const slotOf = (tc: any): CallBuffer => {
    let i = typeof tc?.index === 'number' ? tc.index : tc?.id ? calls.findIndex((c) => c.id === tc.id) : -1;
    if (i < 0) i = calls.length;
    return (calls[i] ??= { name: '', args: '' });
  };
  return {
    onEvent(ev) {
      if (ev.data.trim() === '[DONE]') {
        done = true;
        return undefined;
      }
      let data: any;
      try {
        data = JSON.parse(ev.data);
      } catch {
        return undefined;
      }
      if (data?.usage) usage = usageOf(data.usage);
      const choice = data?.choices?.[0];
      const error = data?.error ?? choice?.error;
      if (error) failure = errorText(error);
      if (typeof choice?.finish_reason === 'string') finish = choice.finish_reason;
      const delta = choice?.delta;
      if (typeof delta?.refusal === 'string' && delta.refusal) refused = true;
      for (const tc of Array.isArray(delta?.tool_calls) ? delta.tool_calls : []) {
        const slot = slotOf(tc);
        if (typeof tc?.id === 'string' && tc.id) slot.id = tc.id;
        if (typeof tc?.function?.name === 'string') slot.name ||= tc.function.name;
        if (typeof tc?.function?.arguments === 'string') slot.args += tc.function.arguments;
        else if (isObj(tc?.function?.arguments)) slot.args = JSON.stringify(tc.function.arguments);
      }
      return typeof delta?.content === 'string' && delta.content && !refused ? delta.content : undefined;
    },
    result() {
      const toolCalls: ToolCall[] = [];
      let fail = failure ?? (finish === 'error' ? 'error finish_reason' : undefined);
      for (const c of calls) {
        if (!c?.name) continue;
        const call = toolCall(c.id, c.name, c.args, req);
        if (typeof call === 'string') fail ??= call;
        else toolCalls.push(call);
      }
      return { toolCalls, usage, finishReason: refused ? 'SAFETY' : geminiFinishReason(finish), failure: fail, complete: done || finish !== undefined };
    },
  };
}

export const openRouterProvider: Provider = {
  models: (purpose) => OPENROUTER_MODELS[purpose] ?? OPENROUTER_MODELS.chat,
  key: getOpenRouterKey,
  request: (model, req, key, stream) => ({
    url: OPENROUTER_CHAT_URL,
    init: {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}`, ...OPENROUTER_HEADERS },
      body: JSON.stringify(buildOpenRouterBody(model, req, stream)),
    },
  }),
  parse: parseCompletion,
  streamState,
};

/** Test hook. */
export function __resetOpenRouterKeyCache() {
  openRouterKey.reset();
}
