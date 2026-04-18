import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';

// ---- Constants ----

export const MODELS = ['gemini-2.5-flash', 'gemini-3.0-flash-preview', 'gemini-2.5-pro'];
export const GEMINI_API_BASE = 'https://generativelanguage.googleapis.com/v1beta';
export const RETRYABLE_STATUS_CODES = [429, 503];

export const REQUEST_TIMEOUT_MS = (() => {
  const v = parseInt(process.env.GEMINI_REQUEST_TIMEOUT_MS || '90000', 10);
  return Number.isFinite(v) && v > 0 ? v : 90000;
})();

// ---- SSM API Key Cache ----

let cachedApiKey: string | undefined;
let apiKeyExpiry = 0;
export const API_KEY_CACHE_TTL = 3600000; // 1 hour

const ssm = new SSMClient({});

export async function getApiKey(): Promise<string> {
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

/** Reset cached key — useful for testing. */
export function _resetApiKeyCache(): void {
  cachedApiKey = undefined;
  apiKeyExpiry = 0;
}

// ---- Gemini API Call ----

export async function callGemini(apiKey: string, prompt: string, signal: AbortSignal): Promise<string> {
  for (let i = 0; i < MODELS.length; i++) {
    const model = MODELS[i];
    const isLast = i === MODELS.length - 1;
    const url = `${GEMINI_API_BASE}/models/${model}:generateContent`;

    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0 },
      }),
      signal,
    });

    if (!resp.ok) {
      const errorText = await resp.text();
      if (!isLast && RETRYABLE_STATUS_CODES.includes(resp.status)) {
        console.warn(`Gemini ${model} returned ${resp.status}, falling back to ${MODELS[i + 1]}`);
        continue;
      }
      throw new Error(`Gemini API error: ${resp.status} ${resp.statusText} - ${errorText}`);
    }

    const data = await resp.json();
    const parts = data.candidates?.[0]?.content?.parts || [];
    const text = parts.filter((p: any) => p.text).pop()?.text;
    if (!text) throw new Error('Gemini returned empty response');
    if (i > 0) console.log(`Used fallback model ${model} successfully`);
    return text.trim();
  }

  throw new Error('All Gemini models failed');
}

// ---- callGeminiWithRetry ----

/**
 * Wraps callGemini with up to 3 retries on 429 errors with exponential backoff (10s, 20s, 40s).
 * Creates its own AbortSignal with REQUEST_TIMEOUT_MS per attempt.
 */
export async function callGeminiWithRetry(apiKey: string, prompt: string): Promise<string> {
  const RETRY_DELAYS = [10_000, 20_000, 40_000];
  const MAX_ATTEMPTS = 3;

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    try {
      const result = await callGemini(apiKey, prompt, controller.signal);
      clearTimeout(timeoutId);
      return result;
    } catch (err: any) {
      clearTimeout(timeoutId);
      const is429 = err?.message?.includes('429');
      if (is429 && attempt < MAX_ATTEMPTS - 1) {
        console.warn(`callGeminiWithRetry: 429 on attempt ${attempt + 1}, retrying in ${RETRY_DELAYS[attempt]}ms`);
        await new Promise(resolve => setTimeout(resolve, RETRY_DELAYS[attempt]));
        continue;
      }
      throw err;
    }
  }

  throw new Error('All Gemini retry attempts failed');
}
