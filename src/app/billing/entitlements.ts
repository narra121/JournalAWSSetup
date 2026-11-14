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
  stripeSubscriptionId?: string;
  endedAt?: string;
  /** `PLANS_VERSION` once the record is on the trial and Pro plans (set at sign-up, or by the first request after the deploy). */
  plansVersion?: number;
}

export const QUOTA_FEATURES: QuotaFeature[] = ['ai_extract', 'ai_insight', 'ai_chat', 'broker_import', 'ai_enhance'];

export const PRO_LIMITS: Record<QuotaFeature, number> = { ai_extract: 200, ai_insight: 30, ai_chat: 500, broker_import: 200, ai_enhance: 500 };
/** Every metered call is a write, which `readOnlyGuard` refuses first; 0 only backs that up. */
export const READ_ONLY_LIMITS: Record<QuotaFeature, number> = { ai_extract: 0, ai_insight: 0, ai_chat: 0, broker_import: 0, ai_enhance: 0 };

export const TRIAL_DAYS = 14;
export const PLANS_VERSION = 2;
const DAY_MS = 86_400_000;

const allFeatures = (value: boolean): Record<GatedFeature, boolean> => ({
  advanced_analytics: value,
  tax_report: value,
  unlimited_accounts: value,
  auto_sync: value,
});

/** Read-only users keep every read; automatic sync writes trades, so it is off. */
const READ_ONLY_FEATURES: Record<GatedFeature, boolean> = { ...allFeatures(true), auto_sync: false };

function isFuture(iso: string | undefined, now: Date): boolean {
  return !!iso && new Date(iso).getTime() > now.getTime();
}

/**
 * Pure plan decision: paid status wins, then an unexpired trial; otherwise `plan: 'free'`, which means no active plan
 * (the trial ended or Pro lapsed): every read works and every write is refused (`isReadOnly`).
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
    // No configured price (SSM missing or unreadable) says nothing about the subscriber's price, so nothing is flagged.
    if (currentPriceIds?.length && sub?.planId) e.legacyPrice = !currentPriceIds.includes(sub.planId);
    return e;
  }
  if (isFuture(sub?.trialEnd, now)) {
    return { plan: 'trial', status: 'trialing', trialEndsAt: sub!.trialEnd, limits: { ...PRO_LIMITS }, features: allFeatures(true) };
  }
  const readOnly: Entitlements = { plan: 'free', status: 'free', limits: { ...READ_ONLY_LIMITS }, features: { ...READ_ONLY_FEATURES } };
  if (sub?.trialEnd) readOnly.trialEndedAt = sub.trialEnd;
  const proEndedAt = sub?.stripeSubscriptionId || sub?.source === 'admin_grant' ? sub.endedAt ?? sub.currentEnd ?? sub.periodEnd : undefined;
  if (proEndedAt) readOnly.proEndedAt = proEndedAt;
  return readOnly;
}

/** Trial over or Pro lapsed: reads only. */
export const isReadOnly = (e: Entitlements): boolean => e.plan === 'free';

/**
 * The record as the trial and Pro plans see it. A record from before them (no `plansVersion`) of a user who is not
 * paying gets the 14-day trial from `now`, never shorter than a trial it already has; a paying record only gains the
 * marker, so a Pro plan that lapses later leads to read-only and not to a new trial. A missing status becomes `trial`.
 */
export function effectiveSubscription<T extends SubscriptionLike>(sub: T | undefined | null, now: Date = new Date()): T & SubscriptionLike & { plansVersion: number } {
  const base = (sub ?? {}) as T;
  if (base.plansVersion === PLANS_VERSION) return base as T & { plansVersion: number };
  if (computeEntitlements(base, now).plan === 'pro') return { ...base, plansVersion: PLANS_VERSION };
  const fresh = new Date(now.getTime() + TRIAL_DAYS * DAY_MS).toISOString();
  const trialEnd = base.trialEnd && base.trialEnd > fresh ? base.trialEnd : fresh;
  return { ...base, status: base.status ?? 'trial', trialEnd, plansVersion: PLANS_VERSION };
}
