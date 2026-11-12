// Shared Hono app contract (CONTRACT §3). Extend additively only — src/features/** codes against this.

export type QuotaFeature = 'ai_extract' | 'ai_insight' | 'ai_chat' | 'broker_import';

export type GatedFeature = 'advanced_analytics' | 'tax_report' | 'unlimited_accounts' | 'auto_sync';

/** What the UI shows for the plan state (BE-E5). */
export type PlanStatus = 'free' | 'trialing' | 'active' | 'past_due' | 'canceling';

export interface Entitlements {
  plan: 'free' | 'trial' | 'pro';
  status: PlanStatus;
  trialEndsAt?: string;
  /** Present only when the Subscriptions record carries them (paid plans). Amounts are in major units (79 = $79). */
  interval?: 'month' | 'year';
  amount?: number;
  currency?: string;
  renewsAt?: string;
  endsAt?: string;
  trialEndedAt?: string;
  /** True when the subscription is on a price that is no longer one of the current Pro prices. */
  legacyPrice?: boolean;
  limits: Record<QuotaFeature, number | null>;
  features: Record<GatedFeature, boolean>;
}

export interface Quota {
  consume(
    feature: QuotaFeature,
    n?: number,
  ): Promise<{ ok: true; remaining: number | null } | { ok: false; limit: number; resetsAt: string }>;
}

export type AppEnv = {
  Variables: {
    userId: string;
    email?: string;
    entitlements: Entitlements;
    quota: Quota;
    requestId: string;
    /** Verified Cognito token claims, stringified like the API Gateway JWT authorizer (additive). */
    claims?: Record<string, string>;
    /** Caller's Subscriptions-table item (undefined = no record); set by `withEntitlements`. */
    subscription?: Record<string, any>;
  };
};
