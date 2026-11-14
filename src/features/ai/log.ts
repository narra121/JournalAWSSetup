import { makeLogger } from '../../shared/logger';
import { AiUnavailableError } from './gemini';

const MAX_ERROR_CHARS = 300;

/** One structured INFO line per answered AI call: the model that served it and the tokens; never the prompt or the answer. */
export function logAiCall(feature: 'chat' | 'insights' | 'enhance', model: string | undefined, usage: { promptTokens: number; outputTokens: number } | undefined, ctx: { requestId?: string; userId?: string }): void {
  makeLogger(ctx).info('ai_call', { feature, model, promptTokens: usage?.promptTokens, outputTokens: usage?.outputTokens });
}

/**
 * One structured WARN line for a failed AI call. Carries the provider's own message (already truncated in
 * ai/runner.ts), the model and the HTTP status; never the prompt, trade data or the API key.
 */
export function logAiFailure(feature: 'chat' | 'insights', e: unknown, ctx: { requestId?: string; userId?: string }): void {
  const err = e as Error | undefined;
  makeLogger(ctx).warn('ai_unavailable', {
    feature,
    model: e instanceof AiUnavailableError ? e.model : undefined,
    status: e instanceof AiUnavailableError ? e.status : undefined,
    errorType: err?.name ?? typeof e,
    error: String(err?.message ?? e).slice(0, MAX_ERROR_CHARS),
  });
}
