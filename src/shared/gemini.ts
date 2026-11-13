import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';

const MODELS = ['gemini-2.5-flash-lite', 'gemini-2.5-flash'];
const GEMINI_API_BASE = 'https://generativelanguage.googleapis.com/v1beta';
const RETRYABLE_STATUS_CODES = [429, 503];

let cachedApiKey: string | undefined;
let apiKeyExpiry = 0;
const API_KEY_CACHE_TTL = 3600000; // 1 hour
const ssm = new SSMClient({});

/** Request timeout in ms from `GEMINI_REQUEST_TIMEOUT_MS`, or `defaultMs` when unset or invalid. */
export function geminiTimeoutMs(defaultMs: number): number {
  const v = parseInt(process.env.GEMINI_REQUEST_TIMEOUT_MS || String(defaultMs), 10);
  return Number.isFinite(v) && v > 0 ? v : defaultMs;
}

export async function getGeminiApiKey(): Promise<string> {
  if (cachedApiKey && Date.now() < apiKeyExpiry) return cachedApiKey;
  const paramName = process.env.GEMINI_API_KEY_PARAM;
  if (!paramName) throw new Error('Missing GEMINI_API_KEY_PARAM');
  const res = await ssm.send(new GetParameterCommand({ Name: paramName, WithDecryption: true }));
  const v = res.Parameter?.Value;
  if (!v) throw new Error('Gemini API key parameter empty');
  cachedApiKey = v;
  apiKeyExpiry = Date.now() + API_KEY_CACHE_TTL;
  return v;
}

export type GeminiPart = { text: string } | { inlineData: { mimeType: string; data: string } };

export class GeminiHttpError extends Error {
  constructor(readonly status: number, statusText: string, body: string) {
    super(`Gemini API error: ${status} ${statusText} - ${body}`);
    this.name = 'GeminiHttpError';
  }
}

/**
 * One generateContent call with fallback to the second model on 429/503. `timeoutMs` is a single deadline for the
 * whole call (both models); on expiry the fetch rejects with an `AbortError`. A non-retryable HTTP error throws
 * GeminiHttpError and a response without text throws a plain Error. `finishReason` is the candidate's ("STOP" when complete).
 */
export async function generateText(opts: {
  parts: GeminiPart[];
  maxOutputTokens: number;
  temperature: number;
  timeoutMs: number;
}): Promise<{ text: string; finishReason?: string }> {
  const apiKey = await getGeminiApiKey();
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), opts.timeoutMs);
  try {
    for (let i = 0; i < MODELS.length; i++) {
      const model = MODELS[i];
      const isLast = i === MODELS.length - 1;
      const resp = await fetch(`${GEMINI_API_BASE}/models/${model}:generateContent`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
        body: JSON.stringify({
          contents: [{ role: 'user', parts: opts.parts }],
          generationConfig: { temperature: opts.temperature, maxOutputTokens: opts.maxOutputTokens, thinkingConfig: { thinkingBudget: 0 } },
        }),
        signal: controller.signal,
      });

      if (!resp.ok) {
        const errorText = await resp.text();
        if (!isLast && RETRYABLE_STATUS_CODES.includes(resp.status)) {
          console.warn(`Gemini ${model} returned ${resp.status}, falling back to ${MODELS[i + 1]}`);
          continue;
        }
        console.error('Gemini HTTP error', { model, status: resp.status, error: errorText.slice(0, 300) });
        throw new GeminiHttpError(resp.status, resp.statusText, errorText);
      }

      const data = await resp.json();
      const candidate = data.candidates?.[0];
      const text = (candidate?.content?.parts || []).filter((p: any) => p.text).pop()?.text?.trim();
      if (!text) throw new Error('Gemini returned empty response');
      if (i > 0) console.log(`Used fallback model ${model} successfully`);
      return { text, finishReason: candidate?.finishReason };
    }
    throw new Error('All Gemini models failed');
  } finally {
    clearTimeout(timeoutId);
  }
}
