import type { Context } from 'hono';
import type { AppEnv, Entitlements, GatedFeature, QuotaFeature } from '../types';

/** Body of the 402 for an exhausted monthly quota (CONTRACT §3, PLAN-BACKEND §4.I.1). */
export function quotaExceededBody(feature: QuotaFeature, entitlements: Entitlements, resetsAt: string, used?: number) {
  const limit = entitlements.limits[feature] ?? 0;
  const message = `Monthly limit reached for ${feature} (${limit}). Resets ${resetsAt.slice(0, 10)}.`;
  return {
    success: false,
    message,
    errorCode: 'QUOTA_EXCEEDED',
    errorMessage: message,
    error: { code: 'QUOTA_EXCEEDED', feature, limit, used: used ?? limit, resetsAt, plan: entitlements.plan },
  };
}

export function quotaExceeded(
  c: Context<AppEnv>,
  feature: QuotaFeature,
  entitlements: Entitlements,
  resetsAt: string,
  used?: number,
) {
  return c.json(quotaExceededBody(feature, entitlements, resetsAt, used), 402);
}

/** 402 for a feature outside the caller's plan; `extra` is merged into `error` (limit, allowedAccountIds). */
export function planRequired(
  c: Context<AppEnv>,
  feature: GatedFeature,
  entitlements: Entitlements,
  extra: Record<string, unknown> = {},
) {
  const message = `Pro plan required for ${feature}.`;
  return c.json(
    {
      success: false,
      message,
      errorCode: 'PLAN_REQUIRED',
      errorMessage: message,
      error: { code: 'PLAN_REQUIRED', feature, plan: entitlements.plan, requiredPlan: 'pro', ...extra },
    },
    402,
  );
}
