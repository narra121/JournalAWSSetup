import { ssmKey, type AiPurpose, type ContentPart, type FetchLike, type GeminiContent, type GeminiRequest, type GeminiUsage, type GenerateResult, type JsonSchema, type StreamChunk, type ToolCall } from './core';
import { aiProvider } from '../../shared/gemini';
import { openRouterProvider } from './openrouter';
import { generateWith, streamWith, type Parsed, type Provider, type StreamState } from './runner';

export * from './core';

const GEMINI_API_BASE = 'https://generativelanguage.googleapis.com/v1beta';
/** Tried in order; the next model answers on 404/429/5xx, a network error, an empty reply or a 400 naming an unsupported field. */
export const GEMINI_MODELS: Record<AiPurpose, readonly string[]> = {
  report: ['gemini-3.5-flash-lite', 'gemini-2.5-flash-lite'],
  chat: ['gemini-3.5-flash-lite', 'gemini-2.5-flash-lite'],
  extract: ['gemini-2.5-flash-lite', 'gemini-3.5-flash-lite'],
};
/** Gemini's documented placeholder for a function call part that has no signature of its own (thought-signatures FAQ). */
const SKIP_SIGNATURE = 'skip_thought_signature_validator';

const geminiKey = ssmKey('GEMINI_API_KEY_PARAM', 'Gemini');
export const getGeminiKey = geminiKey.get;

const isObj = (v: unknown): v is JsonSchema => typeof v === 'object' && v !== null && !Array.isArray(v);
const COPIED = ['description', 'title', 'enum', 'minItems', 'maxItems', 'minimum', 'maximum', 'minLength', 'maxLength', 'pattern', 'propertyOrdering'];
const FORMATS = new Set(['date-time', 'enum', 'float', 'double', 'int32', 'int64']);

/** JSON Schema (or the Gemini dialect, unchanged) to the OpenAPI subset Gemini takes: upper-case types, `nullable`, no `additionalProperties`. */
export function toGeminiSchema(schema: unknown): unknown {
  if (!isObj(schema)) return schema;
  const out: JsonSchema = {};
  let nullable = schema.nullable === true;
  let type = schema.type;
  if (Array.isArray(type)) {
    const real = type.filter((t) => t !== 'null');
    nullable ||= real.length < type.length;
    type = real[0];
  }
  for (const k of COPIED) if (schema[k] !== undefined) out[k] = schema[k];
  if (typeof schema.format === 'string' && FORMATS.has(schema.format)) out.format = schema.format;
  if (Array.isArray(out.enum) && out.enum.includes(null)) {
    out.enum = out.enum.filter((v) => v !== null);
    nullable = true;
  }
  if (schema.const !== undefined && out.enum === undefined) out.enum = [schema.const];
  if (isObj(schema.properties)) out.properties = Object.fromEntries(Object.entries(schema.properties).map(([k, v]) => [k, toGeminiSchema(v)]));
  if (Array.isArray(schema.required)) out.required = schema.required;
  if (schema.items !== undefined) out.items = toGeminiSchema(schema.items);
  if (Array.isArray(schema.anyOf)) {
    const branches = schema.anyOf.filter((b) => !(isObj(b) && b.type === 'null'));
    nullable ||= branches.length < schema.anyOf.length;
    if (branches.length === 1 && type === undefined) Object.assign(out, toGeminiSchema(branches[0]));
    else out.anyOf = branches.map(toGeminiSchema);
  }
  if (typeof type === 'string') out.type = type.toUpperCase();
  if (nullable) out.nullable = true;
  return out;
}

/**
 * Gemini 3 rejects a request whose model turn starts a function call without a thought signature (e.g. one served
 * by the 2.5 fallback), so such parts get the placeholder; 2.5 does not need signatures and gets none.
 */
function contentsFor(contents: GeminiContent[], model: string | undefined): GeminiContent[] {
  if (!model) return contents;
  const legacy = model.startsWith('gemini-2.');
  return contents.map((c) => {
    if (c.role !== 'model' || !c.parts.some((p) => 'functionCall' in p)) return c;
    let first = true;
    const parts = c.parts.map((p): ContentPart => {
      if (!('functionCall' in p)) return p;
      const isFirst = first;
      first = false;
      if (legacy) return { functionCall: p.functionCall };
      return isFirst && !p.thoughtSignature ? { ...p, thoughtSignature: SKIP_SIGNATURE } : p;
    });
    return { ...c, parts };
  });
}

function declaration(t: { name: string; description: string; parameters: JsonSchema }) {
  const hasArgs = isObj(t.parameters?.properties) && Object.keys(t.parameters.properties).length > 0;
  return { name: t.name, description: t.description, ...(hasArgs ? { parameters: toGeminiSchema(t.parameters) } : {}) };
}

/** `model` adjusts thought signatures in function-call turns to what that model accepts. */
export function buildBody(req: GeminiRequest, model?: string) {
  return {
    systemInstruction: { parts: [{ text: req.system }] },
    contents: contentsFor(req.contents, model),
    ...(req.tools?.length ? { tools: [{ functionDeclarations: req.tools.map(declaration) }] } : {}),
    generationConfig: {
      temperature: req.temperature,
      maxOutputTokens: req.maxOutputTokens,
      ...(req.responseSchema ? { responseMimeType: 'application/json', responseSchema: toGeminiSchema(req.responseSchema) } : {}),
    },
  };
}

const usageOf = (u: any): GeminiUsage => ({ promptTokens: u?.promptTokenCount ?? 0, outputTokens: u?.candidatesTokenCount ?? 0 });
const partsOf = (data: any): any[] => (Array.isArray(data?.candidates?.[0]?.content?.parts) ? data.candidates[0].content.parts : []);
const textOf = (parts: any[]): string => parts.map((p) => (typeof p?.text === 'string' && !p.thought ? p.text : '')).join('');
const callsOf = (parts: any[]): ToolCall[] =>
  parts
    .filter((p) => typeof p?.functionCall?.name === 'string')
    .map((p) => ({
      name: p.functionCall.name,
      args: isObj(p.functionCall.args) ? p.functionCall.args : {},
      ...(typeof p.functionCall.id === 'string' ? { id: p.functionCall.id } : {}),
      ...(typeof p.thoughtSignature === 'string' ? { thoughtSignature: p.thoughtSignature } : {}),
    }));
const finishOf = (data: any): string | undefined => data?.candidates?.[0]?.finishReason ?? data?.promptFeedback?.blockReason;

const geminiProvider: Provider = {
  models: (purpose) => GEMINI_MODELS[purpose] ?? GEMINI_MODELS.chat,
  key: getGeminiKey,
  request: (model, req, key, stream) => ({
    url: `${GEMINI_API_BASE}/models/${model}:${stream ? 'streamGenerateContent?alt=sse' : 'generateContent'}`,
    init: { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key }, body: JSON.stringify(buildBody(req, model)) },
  }),
  parse(data): Parsed {
    const parts = partsOf(data);
    return { text: textOf(parts), toolCalls: callsOf(parts), usage: usageOf(data?.usageMetadata), finishReason: finishOf(data) };
  },
  streamState(): StreamState {
    let usage: GeminiUsage = { promptTokens: 0, outputTokens: 0 };
    let finishReason: string | undefined;
    let failure: string | undefined;
    const toolCalls: ToolCall[] = [];
    return {
      onEvent(ev) {
        let data: any;
        try {
          data = JSON.parse(ev.data);
        } catch {
          return undefined;
        }
        if (data?.error) failure = String(data.error.message ?? 'stream error').slice(0, 200);
        if (data?.usageMetadata) usage = usageOf(data.usageMetadata);
        finishReason = finishOf(data) ?? finishReason;
        const parts = partsOf(data);
        toolCalls.push(...callsOf(parts));
        return textOf(parts) || undefined;
      },
      result: () => ({ toolCalls, usage, finishReason, failure, complete: true }),
    };
  },
};

/** OpenRouter unless `AI_PROVIDER=gemini` (rules in shared/gemini.ts `aiProvider`). */
function provider(): Provider {
  return aiProvider() === 'gemini' ? geminiProvider : openRouterProvider;
}

export function generate(req: GeminiRequest, fetchImpl: FetchLike = fetch): Promise<GenerateResult> {
  return generateWith(provider(), req, fetchImpl);
}

/** Streams text; tool calls, when the model makes them, arrive on the `end` chunk. */
export function stream(req: GeminiRequest, fetchImpl: FetchLike = fetch): AsyncGenerator<StreamChunk> {
  return streamWith(provider(), req, fetchImpl);
}

/** Test hook. */
export function __resetGeminiKeyCache() {
  geminiKey.reset();
}
