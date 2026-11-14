import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';
import { isUnsupportedField } from '../features/ai/core';
import { geminiFinishReason, OPENROUTER_CHAT_URL, OPENROUTER_HEADERS, OPENROUTER_MODELS, OPENROUTER_PROVIDER, toMessages } from '../features/ai/openrouter';

export { isUnsupportedField };

const MODELS = ['gemini-2.5-flash-lite', 'gemini-3.5-flash-lite'];
const GEMINI_API_BASE = 'https://generativelanguage.googleapis.com/v1beta';
const RETRYABLE_STATUS_CODES = [404, 429, 500, 502, 503, 504];

export type AiProviderName = 'openrouter' | 'gemini';

/**
 * `AI_PROVIDER` (case-insensitive): `gemini` = the direct Gemini API, anything else = OpenRouter. When it is unset,
 * a function configured with `GEMINI_API_KEY_PARAM` but no `OPENROUTER_API_KEY_PARAM` stays on Gemini.
 */
export function aiProvider(): AiProviderName {
  const v = process.env.AI_PROVIDER?.trim().toLowerCase();
  if (v) return v === 'gemini' ? 'gemini' : 'openrouter';
  return !process.env.OPENROUTER_API_KEY_PARAM && process.env.GEMINI_API_KEY_PARAM ? 'gemini' : 'openrouter';
}

const API_KEY_CACHE_TTL = 3600000; // 1 hour
const ssm = new SSMClient({});

function cachedParam(envName: string, label: string): { get: () => Promise<string>; reset: () => void } {
  let cached: { value: string; expires: number } | undefined;
  return {
    async get() {
      if (cached && Date.now() < cached.expires) return cached.value;
      const paramName = process.env[envName];
      if (!paramName) throw new Error(`Missing ${envName}`);
      const res = await ssm.send(new GetParameterCommand({ Name: paramName, WithDecryption: true }));
      const v = res.Parameter?.Value;
      if (!v) throw new Error(`${label} API key parameter empty`);
      cached = { value: v, expires: Date.now() + API_KEY_CACHE_TTL };
      return v;
    },
    reset() {
      cached = undefined;
    },
  };
}

const geminiKey = cachedParam('GEMINI_API_KEY_PARAM', 'Gemini');
const openRouterKey = cachedParam('OPENROUTER_API_KEY_PARAM', 'OpenRouter');

/** Request timeout in ms from `GEMINI_REQUEST_TIMEOUT_MS`, or `defaultMs` when unset or invalid. */
export function geminiTimeoutMs(defaultMs: number): number {
  const v = parseInt(process.env.GEMINI_REQUEST_TIMEOUT_MS || String(defaultMs), 10);
  return Number.isFinite(v) && v > 0 ? v : defaultMs;
}

export const getGeminiApiKey = geminiKey.get;

export type GeminiPart = { text: string } | { inlineData: { mimeType: string; data: string } };

/** A non-retryable HTTP error from either provider (the name is kept for callers that test it). */
export class GeminiHttpError extends Error {
  constructor(readonly status: number, statusText: string, body: string) {
    super(`Gemini API error: ${status} ${statusText} - ${body}`);
    this.name = 'GeminiHttpError';
  }
}

interface Attempt {
  model: string;
  request: (signal: AbortSignal) => Promise<Response>;
  read: (data: any) => { text: string; finishReason?: string; why: string };
}

function geminiAttempts(apiKey: string, opts: GenerateTextOptions): Attempt[] {
  return MODELS.map((model) => ({
    model,
    request: (signal) =>
      fetch(`${GEMINI_API_BASE}/models/${model}:generateContent`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
        body: JSON.stringify({
          contents: [{ role: 'user', parts: opts.parts }],
          generationConfig: { temperature: opts.temperature, maxOutputTokens: opts.maxOutputTokens },
        }),
        signal,
      }),
    read(data) {
      const candidate = data?.candidates?.[0];
      const text = (candidate?.content?.parts || []).filter((p: any) => typeof p?.text === 'string' && !p.thought).map((p: any) => p.text).join('').trim();
      return { text, finishReason: candidate?.finishReason, why: candidate?.finishReason ?? data?.promptFeedback?.blockReason ?? 'no candidate' };
    },
  }));
}

function openRouterAttempts(apiKey: string, opts: GenerateTextOptions): Attempt[] {
  const messages = toMessages('', [{ role: 'user', parts: opts.parts }]);
  return OPENROUTER_MODELS.extract.map((model) => ({
    model,
    request: (signal) =>
      fetch(OPENROUTER_CHAT_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}`, ...OPENROUTER_HEADERS },
        body: JSON.stringify({
          model,
          messages,
          temperature: opts.temperature,
          max_tokens: opts.maxOutputTokens,
          provider: OPENROUTER_PROVIDER,
        }),
        signal,
      }),
    read(data) {
      const choice = data?.choices?.[0];
      const raw = choice?.message?.content;
      const text = (typeof raw === 'string' ? raw : Array.isArray(raw) ? raw.map((c: any) => (typeof c?.text === 'string' ? c.text : '')).join('') : '').trim();
      const error = data?.error ?? choice?.error;
      const why = error ? `error ${error.code ?? ''} ${String(error.message ?? '').slice(0, 200)}`.trim() : choice?.finish_reason ?? 'no choice';
      return { text: error ? '' : text, finishReason: geminiFinishReason(choice?.finish_reason), why };
    },
  }));
}

interface GenerateTextOptions {
  parts: GeminiPart[];
  maxOutputTokens: number;
  temperature: number;
  timeoutMs: number;
}

/**
 * One call, via OpenRouter on `OPENROUTER_MODELS.extract` (google/gemini-3.5-flash-lite only) unless `aiProvider()` is
 * `gemini`, which tries `MODELS` in order and falls back on 404/429/5xx, a 400 naming an unsupported field or an empty
 * reply. `timeoutMs` is a single deadline for the whole call (every model); on expiry the fetch rejects with an
 * `AbortError`. A non-retryable HTTP error throws GeminiHttpError and a response without text throws
 * `Error('Gemini returned empty response')`. `finishReason` is in Gemini's vocabulary ("STOP" when complete); `model` is
 * the model that answered (after any fallback), for features/ai/log.ts `logAiCall`.
 */
export async function generateText(opts: GenerateTextOptions): Promise<{ text: string; finishReason?: string; model: string }> {
  const viaOpenRouter = aiProvider() === 'openrouter';
  const label = viaOpenRouter ? 'OpenRouter' : 'Gemini';
  const attempts = viaOpenRouter ? openRouterAttempts(await openRouterKey.get(), opts) : geminiAttempts(await geminiKey.get(), opts);
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), opts.timeoutMs);
  try {
    for (let i = 0; i < attempts.length; i++) {
      const { model, request, read } = attempts[i];
      const next = attempts[i + 1]?.model;
      const resp = await request(controller.signal);

      if (!resp.ok) {
        const errorText = await resp.text();
        if (next && (RETRYABLE_STATUS_CODES.includes(resp.status) || isUnsupportedField(resp.status, errorText))) {
          console.warn(`${label} ${model} returned ${resp.status}, falling back to ${next}`);
          continue;
        }
        console.error(`${label} HTTP error`, { model, status: resp.status, error: errorText.slice(0, 300) });
        throw new GeminiHttpError(resp.status, resp.statusText, errorText);
      }

      const { text, finishReason, why } = read(await resp.json());
      if (!text) {
        if (next) {
          console.warn(`${label} ${model} returned no text (${why}), falling back to ${next}`);
          continue;
        }
        console.error(`${label} ${model} returned no text (${why})`);
        throw new Error('Gemini returned empty response');
      }
      if (i > 0) console.log(`Used fallback model ${model} successfully`);
      return { text, finishReason, model };
    }
    throw new Error('All Gemini models failed');
  } finally {
    clearTimeout(timeoutId);
  }
}

/** Test hook. */
export function __resetSharedAiKeyCache() {
  geminiKey.reset();
  openRouterKey.reset();
}
