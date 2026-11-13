import type { Entitlements, GatedFeature, PlanStatus, QuotaFeature } from '../types';

/** Subset of the Subscriptions-table item that decides the plan. */
export interface SubscriptionLike {
  status?: string;
  trialEnd?: string;
  currentEnd?: string;
  interval?: string;
  /** Smallest currency unit (cents, paise), as Stripe reports it. */
  amount?: number;
  currency?: string;
  planId?: string;
  /** Set by admin grants (`source: 'admin_grant'`); a grant stops counting once `periodEnd` has passed. */
  source?: string;
  periodEnd?: string;
}

export const QUOTA_FEATURES: QuotaFeature[] = ['ai_extract', 'ai_insight', 'ai_chat', 'broker_import', 'ai_enhance'];

export const FREE_LIMITS: Record<QuotaFeature, number> = { ai_extract: 5, ai_insight: 1, ai_chat: 10, broker_import: 3, ai_enhance: 20 };
export const PRO_LIMITS: Record<QuotaFeature, number> = { ai_extract: 200, ai_insight: 30, ai_chat: 500, broker_import: 200, ai_enhance: 500 };
export const FREE_ACCOUNT_LIMIT = 2;

const allFeatures = (value: boolean): Record<GatedFeature, boolean> => ({
  advanced_analytics: value,
  tax_report: value,
  unlimited_accounts: value,
  auto_sync: value,
});

function isFuture(iso: string | undefined, now: Date): boolean {
  return !!iso && new Date(iso).getTime() > now.getTime();
}

/**
 * Pure plan decision (CONTRACT §4): paid status wins, then an unexpired trial, otherwise free.
 * Paid plans also carry the billing facts the stored record has (interval, amount, renewal / end date).
 */
export function computeEntitlements(
  sub: SubscriptionLike | undefined | null,
  now: Date = new Date(),
  currentPriceIds?: string[],
): Entitlements {
  const raw = sub?.status ?? 'none';
  const grantExpired = sub?.source === 'admin_grant' && !isFuture(sub?.periodEnd, now);
  const paid =
    (raw === 'active' && !grantExpired) ||
    raw === 'past_due' ||
    (raw === 'cancellation_requested' && isFuture(sub?.currentEnd, now));
  if (paid) {
    const status: PlanStatus = raw === 'past_due' ? 'past_due' : raw === 'cancellation_requested' ? 'canceling' : 'active';
    const e: Entitlements = { plan: 'pro', status, limits: { ...PRO_LIMITS }, features: allFeatures(true) };
    if (sub?.interval === 'month' || sub?.interval === 'year') e.interval = sub.interval;
    if (typeof sub?.amount === 'number') e.amount = sub.amount / 100;
    if (sub?.currency) e.currency = sub.currency;
    if (sub?.currentEnd) {
      if (status === 'canceling') e.endsAt = sub.currentEnd;
      else if (!grantExpired && sub.source !== 'admin_grant') e.renewsAt = sub.currentEnd;
    }
    if (sub?.source === 'admin_grant' && sub.periodEnd) e.endsAt = sub.periodEnd;
    if (currentPriceIds && sub?.planId) e.legacyPrice = !currentPriceIds.includes(sub.planId);
    return e;
  }
  if (isFuture(sub?.trialEnd, now)) {
    return { plan: 'trial', status: 'trialing', trialEndsAt: sub!.trialEnd, limits: { ...PRO_LIMITS }, features: allFeatures(true) };
  }
  const free: Entitlements = { plan: 'free', status: 'free', limits: { ...FREE_LIMITS }, features: allFeatures(false) };
  if (sub?.trialEnd) free.trialEndedAt = sub.trialEnd;
  return free;
}
