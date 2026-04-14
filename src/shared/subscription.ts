import { GetCommand } from '@aws-sdk/lib-dynamodb';
import { ddb } from './dynamo';
import { envelope } from './validation';

const SUBSCRIPTIONS_TABLE = process.env.SUBSCRIPTIONS_TABLE || 'Subscriptions-tradeflow-dev';

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
 * Returns null if access is allowed, or an API Gateway response if denied.
 */
export async function checkSubscription(userId: string): Promise<ReturnType<typeof envelope> | null> {
  try {
    const result = await ddb.send(new GetCommand({
      TableName: SUBSCRIPTIONS_TABLE,
      Key: { userId },
    }));

    const sub = result.Item as SubscriptionRecord | undefined;

    // No subscription record at all
    if (!sub) {
      return subscriptionRequiredResponse('no_subscription', 'No subscription found. Please subscribe to continue using TradeQut.');
    }

    // Active subscription — allow
    if (sub.status === 'active') {
      return null;
    }

    // Trial period — check if still valid
    if (sub.status === 'trial' && sub.trialEnd) {
      const trialEndDate = new Date(sub.trialEnd);
      if (trialEndDate > new Date()) {
        return null; // Trial still active
      }
      return subscriptionRequiredResponse('trial_expired', 'Your free trial has ended. Subscribe to continue using TradeQut.');
    }

    // Map various inactive statuses to denial reasons
    const reasonMap: Record<string, { reason: SubscriptionDenialReason; message: string }> = {
      cancelled: {
        reason: 'subscription_cancelled',
        message: 'Your subscription has been cancelled. Resubscribe to continue using TradeQut.',
      },
      past_due: {
        reason: 'payment_failed',
        message: 'Your payment failed. Please update your payment method to continue using TradeQut.',
      },
      cancellation_requested: {
        reason: 'subscription_ended',
        message: 'Your subscription is ending soon. Renew to keep using TradeQut.',
      },
      created: {
        reason: 'no_subscription',
        message: 'Your subscription setup is incomplete. Please complete checkout to continue.',
      },
      completed: {
        reason: 'subscription_ended',
        message: 'Your subscription has ended. Resubscribe to continue using TradeQut.',
      },
      paused: {
        reason: 'subscription_ended',
        message: 'Your subscription is paused. Resume it to continue using TradeQut.',
      },
    };

    // For cancellation_requested with active period, still allow access
    if (sub.status === 'cancellation_requested' && sub.currentEnd) {
      const periodEnd = new Date(sub.currentEnd);
      if (periodEnd > new Date()) {
        return null; // Still within paid period
      }
    }

    const mapped = reasonMap[sub.status] || {
      reason: 'no_subscription' as SubscriptionDenialReason,
      message: 'Please subscribe to continue using TradeQut.',
    };

    return subscriptionRequiredResponse(mapped.reason, mapped.message);
  } catch (error) {
    console.error('Error checking subscription:', error);
    // On error, allow access (fail open) to avoid blocking users due to DB issues
    return null;
  }
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
];

/**
 * Check if a request path is exempt from subscription checks.
 */
export function isExemptPath(path: string): boolean {
  return EXEMPT_PATHS.some(exempt => path.startsWith(exempt));
}
