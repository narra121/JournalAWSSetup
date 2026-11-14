import type Stripe from 'stripe';

/** Maps Stripe subscription statuses onto the statuses stored in the Subscriptions table. `unpaid` stays its own (non-Pro) status. */
export function normalizeStatus(stripeStatus: string): string {
  switch (stripeStatus) {
    case 'active':
    case 'trialing':
      return 'active';
    case 'canceled':
    case 'incomplete_expired':
      return 'cancelled';
    default:
      return stripeStatus;
  }
}

/** The status to store for a subscription: pause wins, then cancel-at-period-end, otherwise Stripe's normalised status. */
export function subscriptionStatus(subscription: Pick<Stripe.Subscription, 'status' | 'pause_collection' | 'cancel_at_period_end'>): string {
  const status = normalizeStatus(subscription.status);
  // Stripe keeps cancel_at_period_end=true on an ended subscription, so only a live one is re-labelled.
  if (status !== 'active' && status !== 'past_due') return status;
  if (subscription.pause_collection) return 'paused';
  if (subscription.cancel_at_period_end) return 'cancellation_requested';
  return status;
}

/**
 * `lastStripeEventAt` for a state about to be read from Stripe. Stripe stamps events to the second and the write guards
 * accept `lastStripeEventAt <= eventAt`, so rounding down keeps an event of the same second applicable.
 */
export function stripeSnapshotTime(): string {
  return new Date(Math.floor(Date.now() / 1000) * 1000).toISOString();
}
