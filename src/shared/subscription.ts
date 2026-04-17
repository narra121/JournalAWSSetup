import { GetCommand } from '@aws-sdk/lib-dynamodb';
import { ddb } from './dynamo';
import { envelope } from './validation';

// Read at call time (not module load) so tests can stub it
function getSubscriptionsTable(): string {
  return process.env.SUBSCRIPTIONS_TABLE || '';
}

export interface SubscriptionRecord {
  userId: string;
  status: string;
  trialEnd?: string;
  stripeSubscriptionId?: string;
  stripeCustomerId?: string;
  planId?: string;
  paidCount?: number;
  currentStart?: string;
  currentEnd?: string;
  chargeAt?: string;
  cancelAt?: string;
  endedAt?: string;
  checkoutSessionId?: string;
  checkoutUrl?: string;
  createdAt?: string;
  updatedAt?: string;
}

export type SubscriptionDenialReason =
  | 'trial_expired'
  | 'subscription_cancelled'
  | 'payment_failed'
  | 'subscription_ended'
  | 'no_subscription';

/**
 * Check if a user has an active subscription or trial.
 * Returns null to allow access for ALL subscription states (free tier with ads).
 * Only returns non-null (503) on DynamoDB infrastructure errors.
 */
export async function checkSubscription(userId: string): Promise<ReturnType<typeof envelope> | null> {
  try {
    const tableName = getSubscriptionsTable();
    if (!tableName) {
      console.error('SUBSCRIPTIONS_TABLE env var is not set');
      return subscriptionErrorResponse();
    }

    // Read the subscription record — but all states now allow access
    await ddb.send(new GetCommand({
      TableName: tableName,
      Key: { userId },
    }));

    // All subscription states allow access (free tier with ads for non-paying users)
    return null;
  } catch (error) {
    console.error('Error checking subscription:', error);
    return subscriptionErrorResponse();
  }
}

// ─── Subscription Tier ──────────────────────────────────────────

export type SubscriptionTier = 'paid' | 'trial' | 'free_with_ads';

export interface TierResult {
  tier: SubscriptionTier;
  showAds: boolean;
  trialEnd?: string;
  status: string;
}

/**
 * Determine the subscription tier for a user.
 * Reads the DynamoDB subscription record and returns tier info.
 * Fails open: returns free_with_ads on errors so users are never locked out.
 */
export async function getSubscriptionTier(userId: string): Promise<TierResult> {
  try {
    const tableName = getSubscriptionsTable();
    if (!tableName) {
      console.error('SUBSCRIPTIONS_TABLE env var is not set');
      return { tier: 'free_with_ads', showAds: true, status: 'error' };
    }

    const result = await ddb.send(new GetCommand({
      TableName: tableName,
      Key: { userId },
    }));

    const sub = result.Item as SubscriptionRecord | undefined;

    // No subscription record at all
    if (!sub) {
      return { tier: 'free_with_ads', showAds: true, status: 'none' };
    }

    const now = new Date();

    // Active subscription — paid tier
    if (sub.status === 'active') {
      return { tier: 'paid', showAds: false, status: 'active' };
    }

    // Trial period — check if still valid
    if (sub.status === 'trial') {
      if (sub.trialEnd && new Date(sub.trialEnd) > now) {
        return { tier: 'trial', showAds: false, trialEnd: sub.trialEnd, status: 'trial' };
      }
      return { tier: 'free_with_ads', showAds: true, trialEnd: sub.trialEnd, status: 'trial' };
    }

    // Cancellation requested — still paid if within current period
    if (sub.status === 'cancellation_requested') {
      if (sub.currentEnd && new Date(sub.currentEnd) > now) {
        return { tier: 'paid', showAds: false, status: 'cancellation_requested' };
      }
      return { tier: 'free_with_ads', showAds: true, status: 'cancellation_requested' };
    }

    // All other statuses: cancelled, completed, paused, past_due, created
    return { tier: 'free_with_ads', showAds: true, status: sub.status };
  } catch (error) {
    console.error('Error getting subscription tier:', error);
    return { tier: 'free_with_ads', showAds: true, status: 'error' };
  }
}

// ─── Response helpers (kept for potential future use) ────────────

function subscriptionErrorResponse() {
  return envelope({
    statusCode: 503,
    error: {
      code: 'SUBSCRIPTION_CHECK_FAILED',
      message: 'Unable to verify subscription. Please try again.',
    },
    message: 'Service temporarily unavailable',
  });
}

function subscriptionRequiredResponse(reason: SubscriptionDenialReason, message: string) {
  return envelope({
    statusCode: 403,
    error: {
      code: 'SUBSCRIPTION_REQUIRED',
      message,
      details: { reason, renewUrl: '/app/profile' },
    },
    message,
  });
}

/**
 * List of API path prefixes that are exempt from subscription checks.
 * These endpoints should always be accessible regardless of subscription status.
 */
const EXEMPT_PATHS = [
  '/v1/user/profile',
  '/v1/subscriptions',
  '/v1/payments/webhook',
  '/v1/auth',
  '/v1/user/preferences',
  '/v1/user/notifications',
  '/v1/ad-config',
];

/**
 * Check if a request path is exempt from subscription checks.
 */
export function isExemptPath(path: string): boolean {
  return EXEMPT_PATHS.some(exempt => path.startsWith(exempt));
}
