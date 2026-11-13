import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';
import { SseParser } from './sse';

const GEMINI_API_BASE = 'https://generativelanguage.googleapis.com/v1beta';
/** Primary then fallback (on 429/503/404); same model family and SSM key as handlers/extract-trades. */
export const GEMINI_MODELS = ['gemini-2.5-flash', 'gemini-2.5-flash-lite'];
const RETRYABLE = new Set([429, 500, 503, 404]);
const KEY_TTL_MS = 3_600_000;
/** After a failed first model, the fallback is only tried when at least this much of the deadline is left. */
const MIN_FALLBACK_MS = 10_000;
/** Overall deadline of a call that sets no `timeoutMs`: below CloudFront's 60 s origin timeout and the Web Function's 58 s (template.yaml `TimeoutSeconds`). */
const DEFAULT_DEADLINE_MS = 50_000;

/** `model` and `status` are those of the last failed attempt (status 0 = network error/timeout); undefined for config errors. */
export class AiUnavailableError extends Error {
  constructor(message: string, readonly model?: string, readonly status?: number) {
    super(message);
  }
}

let cachedKey: { value: string; expires: number } | null = null;
const ssm = new SSMClient({});

export async function getGeminiKey(): Promise<string> {
  if (cachedKey && Date.now() < cachedKey.expires) return cachedKey.value;
  const name = process.env.GEMINI_API_KEY_PARAM;
  if (!name) throw new AiUnavailableError('GEMINI_API_KEY_PARAM not configured');
  const res = await ssm.send(new GetParameterCommand({ Name: name, WithDecryption: true }));
  const value = res.Parameter?.Value;
  if (!value) throw new AiUnavailableError('Gemini API key parameter empty');
  cachedKey = { value, expires: Date.now() + KEY_TTL_MS };
  return value;
}

export interface GeminiContent {
  role: 'user' | 'model';
  parts: { text: string }[];
}

export interface GeminiRequest {
  system: string;
  contents: GeminiContent[];
  temperature: number;
  maxOutputTokens: number;
  /** Gemini Schema object (OpenAPI subset); sets responseMimeType application/json */
  responseSchema?: unknown;
  /** One deadline for the whole call, fallback model included (default `DEFAULT_DEADLINE_MS`). */
  timeoutMs?: number;
  /** Aborts the call as well, e.g. when the client that asked for it has gone. */
  signal?: AbortSignal;
}

export interface GeminiUsage {
  promptTokens: number;
  outputTokens: number;
}

export function buildBody(req: GeminiRequest) {
  return {
    systemInstruction: { parts: [{ text: req.system }] },
    contents: req.contents,
    generationConfig: {
      temperature: req.temperature,
      maxOutputTokens: req.maxOutputTokens,
      thinkingConfig: { thinkingBudget: 0 },
      ...(req.responseSchema ? { responseMimeType: 'application/json', responseSchema: req.responseSchema } : {}),
    },
  };
}

const usageOf = (u: any): GeminiUsage => ({ promptTokens: u?.promptTokenCount ?? 0, outputTokens: u?.candidatesTokenCount ?? 0 });
const textOf = (data: any): string =>
  (data?.candidates?.[0]?.content?.parts ?? []).map((p: any) => (typeof p?.text === 'string' && !p.thought ? p.text : '')).join('');

type FetchLike = typeof fetch;

/** Signal for one attempt: the time left of the overall deadline, plus the caller's own signal. */
function attemptSignal(req: GeminiRequest, left: number): AbortSignal {
  const timeout = AbortSignal.timeout(left);
  return req.signal ? AbortSignal.any([req.signal, timeout]) : timeout;
}

export async function generate(req: GeminiRequest, fetchImpl: FetchLike = fetch): Promise<{ text: string; model: string; usage: GeminiUsage }> {
  const key = await getGeminiKey();
  let lastErr = '';
  let lastModel: string | undefined;
  let lastStatus: number | undefined;
  const deadline = Date.now() + (req.timeoutMs ?? DEFAULT_DEADLINE_MS);
  for (const model of GEMINI_MODELS) {
    const left = deadline - Date.now();
    if (req.signal?.aborted) throw new AiUnavailableError('Request aborted', lastModel, lastStatus);
    if (lastModel !== undefined && left < MIN_FALLBACK_MS) break;
    const res = await fetchImpl(`${GEMINI_API_BASE}/models/${model}:generateContent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
      body: JSON.stringify(buildBody(req)),
      signal: attemptSignal(req, left),
    }).catch((e: Error) => ({ ok: false, status: 0, text: async () => e.message }) as Response);
    if (!res.ok) {
      lastErr = `${model} ${res.status} ${(await res.text()).slice(0, 200)}`;
      lastModel = model;
      lastStatus = res.status;
      if (RETRYABLE.has(res.status) || res.status === 0) continue;
      throw new AiUnavailableError(lastErr, model, res.status);
    }
    const data = await res.json();
    const text = textOf(data);
    if (!text) {
      lastErr = `${model} empty response (${data?.candidates?.[0]?.finishReason ?? 'no candidate'})`;
      lastModel = model;
      lastStatus = 200;
      continue;
    }
    return { text, model, usage: usageOf(data.usageMetadata) };
  }
  throw new AiUnavailableError(lastErr || 'All Gemini models failed', lastModel, lastStatus);
}

export type StreamChunk = { type: 'text'; text: string } | { type: 'end'; model: string; usage: GeminiUsage; finishReason?: string };

/**
 * Streams text via streamGenerateContent?alt=sse. Falls back to the next model only before the first byte;
 * a failure mid-stream throws (the caller already forwarded tokens).
 */
export async function* stream(req: GeminiRequest, fetchImpl: FetchLike = fetch): AsyncGenerator<StreamChunk> {
  const key = await getGeminiKey();
  let lastErr = '';
  let lastModel: string | undefined;
  let lastStatus: number | undefined;
  const deadline = Date.now() + (req.timeoutMs ?? DEFAULT_DEADLINE_MS);
  for (const model of GEMINI_MODELS) {
    const left = deadline - Date.now();
    if (req.signal?.aborted) throw new AiUnavailableError('Request aborted', lastModel, lastStatus);
    if (lastModel !== undefined && left < MIN_FALLBACK_MS) break;
    const res = await fetchImpl(`${GEMINI_API_BASE}/models/${model}:streamGenerateContent?alt=sse`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
      body: JSON.stringify(buildBody(req)),
      signal: attemptSignal(req, left),
    }).catch((e: Error) => ({ ok: false, status: 0, text: async () => e.message, body: null }) as unknown as Response);
    if (!res.ok || !res.body) {
      lastErr = `${model} ${res.status} ${(await res.text()).slice(0, 200)}`;
      lastModel = model;
      lastStatus = res.status;
      if (RETRYABLE.has(res.status) || res.status === 0) continue;
      throw new AiUnavailableError(lastErr, model, res.status);
    }
    const parser = new SseParser();
    const decoder = new TextDecoder();
    let usage: GeminiUsage = { promptTokens: 0, outputTokens: 0 };
    let finishReason: string | undefined;
    let sawText = false;
    const reader = res.body.getReader();
    const handle = function* (events: { data: string }[]) {
      for (const ev of events) {
        let data: any;
        try {
          data = JSON.parse(ev.data);
        } catch {
          continue;
        }
        if (data.usageMetadata) usage = usageOf(data.usageMetadata);
        finishReason = data?.candidates?.[0]?.finishReason ?? finishReason;
        const t = textOf(data);
        if (t) {
          sawText = true;
          yield { type: 'text' as const, text: t };
        }
      }
    };
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      yield* handle(parser.push(decoder.decode(value, { stream: true })));
    }
    yield* handle(parser.end());
    // A 200 with no text (a safety block, an empty candidate) is a failure like in generate(): nothing was forwarded, so the next model may answer.
    if (!sawText && model !== GEMINI_MODELS[GEMINI_MODELS.length - 1]) {
      lastErr = `${model} empty response (${finishReason ?? 'no candidate'})`;
      lastModel = model;
      lastStatus = 200;
      continue;
    }
    yield { type: 'end', model, usage, finishReason };
    return;
  }
  throw new AiUnavailableError(lastErr || 'All Gemini models failed', lastModel, lastStatus);
}

/** Test hook. */
export function __resetGeminiKeyCache() {
  cachedKey = null;
}
