import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';

/**
 * A 400 that names a field or argument the model does not take; the next model may take it. Google answers a field
 * one model rejects with the bare "Request contains an invalid argument." (2026-11-13 live check), so that counts;
 * "API key not valid" and other 400s do not. Also used by shared/gemini.ts.
 */
export function isUnsupportedField(status: number, body: string): boolean {
  if (status !== 400) return false;
  let message = body;
  try {
    const m = JSON.parse(body)?.error?.message;
    if (typeof m === 'string') message = m;
  } catch {
    /* not JSON */
  }
  return /unsupported|not supported|unknown name|unknown parameter|unknown field|unrecognized|cannot find field|invalid argument/i.test(message);
}

/** `model` and `status` are those of the last failed attempt (status 0 = network error/timeout); undefined for config errors. */
export class AiUnavailableError extends Error {
  constructor(message: string, readonly model?: string, readonly status?: number) {
    super(message);
  }
}

/** Picks the model list on either provider; `chat` when absent. */
export type AiPurpose = 'report' | 'chat' | 'extract';

/** Plain JSON Schema (lower-case types). The Gemini dialect (upper-case types, `nullable`) is accepted too. */
export type JsonSchema = { [key: string]: unknown };

export interface ToolDecl {
  name: string;
  description: string;
  /** JSON Schema of the arguments object. */
  parameters: JsonSchema;
}

/** One function call the model asked for. Send it back unchanged in the next request (see `toolCallTurn`). */
export interface ToolCall {
  name: string;
  args: Record<string, unknown>;
  /** Gemini 3 functionCall id or OpenRouter tool_call id; the matching result must carry the same id. */
  id?: string;
  /** Direct Gemini only; Gemini 3 rejects the next request when it is not returned on its part. */
  thoughtSignature?: string;
}

export type TextPart = { text: string; thought?: boolean; thoughtSignature?: string };
/** `text?: undefined` keeps `parts[i].text` readable on the union. */
export type FunctionCallPart = { functionCall: { name: string; args?: Record<string, unknown>; id?: string }; thoughtSignature?: string; text?: undefined };
export type FunctionResponsePart = { functionResponse: { name: string; response: Record<string, unknown>; id?: string }; text?: undefined };
/** An image in a user turn; `data` is base64 without the `data:` prefix. */
export type InlineDataPart = { inlineData: { mimeType: string; data: string }; text?: undefined };
export type ContentPart = TextPart | FunctionCallPart | FunctionResponsePart | InlineDataPart;

export interface GeminiContent {
  role: 'user' | 'model';
  parts: ContentPart[];
}

export interface GeminiRequest {
  system: string;
  contents: GeminiContent[];
  temperature: number;
  maxOutputTokens: number;
  /** JSON Schema or Gemini Schema object; the reply is JSON text matching it. */
  responseSchema?: unknown;
  /** Functions the model may call; calls come back as `toolCalls`. */
  tools?: ToolDecl[];
  /** Model choice; default `chat`. */
  purpose?: AiPurpose;
  /** One deadline for the whole call, fallback model included (default `DEFAULT_DEADLINE_MS`). */
  timeoutMs?: number;
  /** Aborts the call as well, e.g. when the client that asked for it has gone. */
  signal?: AbortSignal;
}

export interface GeminiUsage {
  promptTokens: number;
  outputTokens: number;
  /** OpenRouter credits (1 credit = 1 USD) when OpenRouter reports them; absent on direct Gemini. */
  cost?: number;
}

export interface GenerateResult {
  text: string;
  model: string;
  usage: GeminiUsage;
  /** Present when the model called functions; `text` may then be empty. */
  toolCalls?: ToolCall[];
  /** Gemini vocabulary on both providers: STOP, MAX_TOKENS, SAFETY, ... */
  finishReason?: string;
}

export type StreamChunk =
  | { type: 'text'; text: string }
  | { type: 'end'; model: string; usage: GeminiUsage; finishReason?: string; toolCalls?: ToolCall[] };

export type FetchLike = typeof fetch;

export const RETRYABLE = new Set([404, 429, 500, 502, 503, 504]);
/** After a failed first model, the fallback is only tried when at least this much of the deadline is left. */
export const MIN_FALLBACK_MS = 10_000;
/** Overall deadline of a call that sets no `timeoutMs`: below CloudFront's 60 s origin timeout and the Web Function's 58 s (template.yaml `TimeoutSeconds`). */
export const DEFAULT_DEADLINE_MS = 50_000;

export const shouldFallThrough = (status: number, body: string) => status === 0 || RETRYABLE.has(status) || isUnsupportedField(status, body);

/** Signal for one attempt: the time left of the overall deadline, plus the caller's own signal. */
export function attemptSignal(req: GeminiRequest, left: number): AbortSignal {
  const timeout = AbortSignal.timeout(left);
  return req.signal ? AbortSignal.any([req.signal, timeout]) : timeout;
}

/** A failed fetch as a response with status 0, so the fallback loop treats it like any other failure. */
export const networkFailure = (e: Error) => ({ ok: false, status: 0, body: null, text: async () => e?.message ?? String(e) }) as unknown as Response;

const KEY_TTL_MS = 3_600_000;
const ssm = new SSMClient({});

/** Reads a SecureString named by an env var, cached for an hour. */
export function ssmKey(envName: string, label: string): { get: () => Promise<string>; reset: () => void } {
  let cached: { value: string; expires: number } | null = null;
  return {
    async get() {
      if (cached && Date.now() < cached.expires) return cached.value;
      const name = process.env[envName];
      if (!name) throw new AiUnavailableError(`${envName} not configured`);
      const res = await ssm.send(new GetParameterCommand({ Name: name, WithDecryption: true }));
      const value = res.Parameter?.Value;
      if (!value) throw new AiUnavailableError(`${label} API key parameter empty`);
      cached = { value, expires: Date.now() + KEY_TTL_MS };
      return value;
    },
    reset() {
      cached = null;
    },
  };
}

/** The model turn that carries the calls back to the model, ready to append to `contents`. */
export function toolCallTurn(calls: ToolCall[]): GeminiContent {
  return {
    role: 'model',
    parts: calls.map((c) => ({ functionCall: { name: c.name, args: c.args, ...(c.id ? { id: c.id } : {}) }, ...(c.thoughtSignature ? { thoughtSignature: c.thoughtSignature } : {}) })),
  };
}

/** The user turn with the tool results, in the order of the calls. A result that is not a plain object is sent as `{ result }`. */
export function toolResultTurn(results: { call: ToolCall; result: unknown }[]): GeminiContent {
  const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
  return {
    role: 'user',
    parts: results.map(({ call, result }) => ({
      functionResponse: { name: call.name, response: isObject(result) ? result : { result }, ...(call.id ? { id: call.id } : {}) },
    })),
  };
}
