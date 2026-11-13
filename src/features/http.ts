import type { Context } from 'hono';
import { errorBody, plainMessage, type ErrorDetails, type FieldError } from '../shared/apiError';
import { quotaExceededBody } from '../app/billing/responses';
import type { AppEnv, Entitlements, QuotaFeature } from '../app/types';

type Ctx = Context<AppEnv>;
type Status = 200 | 201 | 400 | 401 | 402 | 403 | 404 | 405 | 409 | 413 | 422 | 429 | 500 | 502 | 503 | 504;

/** Same body shape as src/shared/validation.ts#envelope so the frontend's response unwrapping works unchanged. */
export const ok = (c: Ctx, data: unknown, status: Status = 200) => c.json({ success: true, message: 'Success', data }, status);

/** The error contract (src/shared/apiError.ts); `details` lands in `error` (retryAfter, fields, plan data). */
export const fail = (c: Ctx, status: Status, code: string, message: string, details?: ErrorDetails | FieldError[]) =>
  c.json(errorBody(code, plainMessage(status, message) ?? message, details), status);

/** 402 with the quota data in `error` (CONTRACT §3): the body the billing middleware sends, with the limit the quota reported. */
export const quotaFail = (c: Ctx, feature: QuotaFeature, res: { limit: number; resetsAt: string }) => {
  const entitlements = c.get('entitlements');
  return c.json(quotaExceededBody(feature, { ...entitlements, limits: { ...entitlements?.limits, [feature]: res.limit } } as Entitlements, res.resetsAt), 402);
};

export async function readJson(c: Ctx): Promise<Record<string, unknown> | null> {
  try {
    const v = await c.req.json();
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}
