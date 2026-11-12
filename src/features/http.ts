import type { Context } from 'hono';
import type { AppEnv, QuotaFeature } from '../app/types';

type Ctx = Context<AppEnv>;
type Status = 200 | 201 | 400 | 401 | 402 | 403 | 404 | 409 | 413 | 422 | 429 | 500 | 502;

/** Same body shape as src/shared/validation.ts#envelope so the frontend's response unwrapping works unchanged. */
export const ok = (c: Ctx, data: unknown, status: Status = 200) => c.json({ success: true, message: 'Success', data }, status);

export const fail = (c: Ctx, status: Status, code: string, message: string, extra: Record<string, unknown> = {}) =>
  c.json({ success: false, message, errorCode: code, errorMessage: message, ...extra }, status);

/** 402 carrying both the envelope fields and CONTRACT §3's `error` object. */
export const quotaFail = (c: Ctx, feature: QuotaFeature, res: { limit: number; resetsAt: string }) =>
  fail(c, 402, 'QUOTA_EXCEEDED', `Monthly limit reached for ${feature} (${res.limit}). Resets ${res.resetsAt.slice(0, 10)}.`, {
    error: { code: 'QUOTA_EXCEEDED', feature, limit: res.limit, used: res.limit, resetsAt: res.resetsAt, plan: c.get('entitlements')?.plan },
  });

export async function readJson(c: Ctx): Promise<Record<string, unknown> | null> {
  try {
    const v = await c.req.json();
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}
