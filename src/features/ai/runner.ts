import {
  AiUnavailableError, attemptSignal, DEFAULT_DEADLINE_MS, MIN_FALLBACK_MS, networkFailure, shouldFallThrough,
  type AiPurpose, type FetchLike, type GeminiRequest, type GeminiUsage, type GenerateResult, type StreamChunk, type ToolCall,
} from './core';
import { SseParser, type SseEvent } from './sse';

/** One provider reply. `failure` = the provider reported an error inside a 200 (or the reply is unusable). */
export interface Parsed {
  text: string;
  toolCalls: ToolCall[];
  usage: GeminiUsage;
  finishReason?: string;
  failure?: string;
}

export interface StreamState {
  /** Returns the text delta the event carries, if any. */
  onEvent(ev: SseEvent): string | undefined;
  /** `complete` = the provider sent its end-of-response marker. */
  result(): Omit<Parsed, 'text'> & { complete: boolean };
}

export interface Provider {
  models(purpose: AiPurpose): readonly string[];
  key(): Promise<string>;
  request(model: string, req: GeminiRequest, key: string, stream: boolean): { url: string; init: RequestInit };
  parse(data: any, req: GeminiRequest): Parsed;
  streamState(req: GeminiRequest): StreamState;
}

class Attempts {
  err = '';
  model?: string;
  status?: number;
  readonly deadline: number;
  constructor(private readonly req: GeminiRequest) {
    this.deadline = Date.now() + (req.timeoutMs ?? DEFAULT_DEADLINE_MS);
  }

  /** Time left for the next model, or null when no further model may be tried. */
  next(): number | null {
    if (this.req.signal?.aborted) throw new AiUnavailableError('Request aborted', this.model, this.status);
    const left = this.deadline - Date.now();
    return this.model !== undefined && left < MIN_FALLBACK_MS ? null : left;
  }
  fail(model: string, status: number, detail: string) {
    this.err = `${model} ${detail}`;
    this.model = model;
    this.status = status;
  }
  error() {
    return new AiUnavailableError(this.err || 'All AI models failed', this.model, this.status);
  }
}

/** Sends the request; a failed HTTP status is recorded, and thrown unless the next model may answer. Null = try the next model. */
async function send(p: Provider, req: GeminiRequest, key: string, model: string, left: number, stream: boolean, fetchImpl: FetchLike, at: Attempts) {
  const { url, init } = p.request(model, req, key, stream);
  const res = await fetchImpl(url, { ...init, signal: attemptSignal(req, left) }).catch(networkFailure);
  if (res.ok && (!stream || res.body)) return res;
  const body = await res.text().catch(() => '');
  at.fail(model, res.status, `${res.status} ${body.slice(0, 200)}`);
  if (shouldFallThrough(res.status, body)) return null;
  throw at.error();
}

export async function generateWith(p: Provider, req: GeminiRequest, fetchImpl: FetchLike): Promise<GenerateResult> {
  const key = await p.key();
  const at = new Attempts(req);
  for (const model of p.models(req.purpose ?? 'chat')) {
    const left = at.next();
    if (left === null) break;
    const res = await send(p, req, key, model, left, false, fetchImpl, at);
    if (!res) continue;
    let data: unknown;
    try {
      data = await res.json();
    } catch (e) {
      at.fail(model, 0, `unreadable response: ${(e as Error)?.message}`);
      continue;
    }
    const r = p.parse(data, req);
    if (r.failure || (!r.text && !r.toolCalls.length)) {
      at.fail(model, 200, r.failure ?? `empty response (${r.finishReason ?? 'no candidate'})`);
      continue;
    }
    return { text: r.text, model, usage: r.usage, ...(r.toolCalls.length ? { toolCalls: r.toolCalls } : {}), ...(r.finishReason ? { finishReason: r.finishReason } : {}) };
  }
  throw at.error();
}

/**
 * Falls back to the next model only while nothing was forwarded; once text was yielded, a broken, failed or
 * unfinished stream throws (the caller already sent tokens). When the last model answers with nothing, the stream
 * ends with only the `end` chunk.
 */
export async function* streamWith(p: Provider, req: GeminiRequest, fetchImpl: FetchLike): AsyncGenerator<StreamChunk> {
  const key = await p.key();
  const at = new Attempts(req);
  const models = p.models(req.purpose ?? 'chat');
  for (const [i, model] of models.entries()) {
    const left = at.next();
    if (left === null) break;
    const res = await send(p, req, key, model, left, true, fetchImpl, at);
    if (!res) continue;
    const state = p.streamState(req);
    const parser = new SseParser();
    const decoder = new TextDecoder();
    const reader = res.body!.getReader();
    let sawText = false;
    let broken: string | undefined;
    try {
      for (;;) {
        let chunk: ReadableStreamReadResult<Uint8Array>;
        try {
          chunk = await reader.read();
        } catch (e) {
          broken = `stream broke: ${(e as Error)?.message ?? e}`;
          break;
        }
        const events = chunk.done ? parser.end() : parser.push(decoder.decode(chunk.value, { stream: true }));
        for (const ev of events) {
          const t = state.onEvent(ev);
          if (t) {
            sawText = true;
            yield { type: 'text', text: t };
          }
        }
        if (chunk.done) break;
      }
    } finally {
      reader.cancel().catch(() => undefined);
    }
    const r = state.result();
    const problem = broken ?? r.failure ?? (r.complete ? undefined : 'stream ended before the response was complete');
    if (problem) {
      at.fail(model, broken ? 0 : 200, problem);
      if (sawText) throw at.error();
      continue;
    }
    if (!sawText && !r.toolCalls.length && i < models.length - 1) {
      at.fail(model, 200, `empty response (${r.finishReason ?? 'no candidate'})`);
      continue;
    }
    yield { type: 'end', model, usage: r.usage, finishReason: r.finishReason, ...(r.toolCalls.length ? { toolCalls: r.toolCalls } : {}) };
    return;
  }
  throw at.error();
}
