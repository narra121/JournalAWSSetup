import type { Context } from 'hono';
import { errorBody } from '../../shared/apiError';
import type { AppEnv, Entitlements, GatedFeature, QuotaFeature } from '../types';

const QUOTA_LABEL: Record<QuotaFeature, string> = {
  ai_extract: 'AI trade extractions',
  ai_insight: 'AI reports',
  ai_chat: 'AI chats',
  broker_import: 'broker imports',
  ai_enhance: 'AI text improvements',
};

const PLAN_MESSAGE: Record<GatedFeature, string> = {
  advanced_analytics: 'Advanced analytics is part of the Pro plan.',
  tax_report: 'The tax report is part of the Pro plan.',
  unlimited_accounts: 'Using more trading accounts needs the Pro plan.',
  auto_sync: 'Automatic sync is part of the Pro plan.',
};

/** A limit of 0 means the plan does not include the feature at all. */
export function quotaMessage(feature: QuotaFeature, limit: number, resetsAt: string): string {
  const label = QUOTA_LABEL[feature];
  return limit > 0
    ? `You've used all ${limit} ${label} this month. Your limit resets on ${resetsAt.slice(0, 10)}.`
    : `${label.charAt(0).toUpperCase()}${label.slice(1)} are part of the Pro plan.`;
}

/** Body of the 402 for an exhausted monthly quota (CONTRACT §3, PLAN-BACKEND §4.I.1): the quota data is in `error`. */
export function quotaExceededBody(feature: QuotaFeature, entitlements: Entitlements, resetsAt: string, used?: number) {
  const limit = entitlements.limits[feature] ?? 0;
  return errorBody('QUOTA_EXCEEDED', quotaMessage(feature, limit, resetsAt), { feature, limit, used: used ?? limit, resetsAt, plan: entitlements.plan });
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
  return c.json(errorBody('PLAN_REQUIRED', PLAN_MESSAGE[feature], { feature, plan: entitlements.plan, requiredPlan: 'pro', ...extra }), 402);
}
