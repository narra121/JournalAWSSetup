import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { UpdateCommand } from '@aws-sdk/lib-dynamodb';
import type Stripe from 'stripe';
import { ddb } from '../../shared/dynamo';
import { ErrorCodes, envelope, errorResponse } from '../../shared/validation';
import { getUserEmail, paymentFailedMail, sendEmail } from '../../shared/email';
import { getStripe, readParam } from '../../shared/stripe-config';
import { subscriptionStatus } from '../../shared/stripe-status';

const SUBSCRIPTIONS_TABLE = process.env.SUBSCRIPTIONS_TABLE!;

async function getWebhookSecret(): Promise<string> {
  const secret = await readParam(process.env.STRIPE_WEBHOOK_SECRET_PARAM!);
  if (!secret) throw new Error('Stripe webhook secret not found in SSM');
  return secret;
}

function unixToISO(unix: number): string {
  return new Date(unix * 1000).toISOString();
}

/** Condition that rejects an event older than the last one applied (Stripe delivers out of order and retries). */
const FRESH_EVENT = 'attribute_not_exists(lastStripeEventAt) OR lastStripeEventAt <= :eventAt';

/**
 * Runs an update guarded by FRESH_EVENT; a stale event is acknowledged without changing anything and returns false.
 * Unless `upsert` is set the row must exist, so a late event cannot recreate the row of a deleted user. With
 * `subscriptionId` only that subscription's events apply, unless the row has no subscription yet or is cancelled.
 */
async function applyFresh(
  eventAt: string,
  update: { UpdateExpression: string; ExpressionAttributeNames?: Record<string, string>; ExpressionAttributeValues: Record<string, any>; ConditionExpression?: string },
  userId: string,
  label: string,
  guard: { upsert?: boolean; subscriptionId?: string } = {}
): Promise<boolean> {
  const conditions = [`(${FRESH_EVENT})`];
  if (update.ConditionExpression) conditions.unshift(`(${update.ConditionExpression})`);
  if (!guard.upsert) conditions.push('attribute_exists(userId)');
  const names: Record<string, string> = { ...update.ExpressionAttributeNames };
  const values: Record<string, any> = { ...update.ExpressionAttributeValues, ':eventAt': eventAt };
  if (guard.subscriptionId) {
    conditions.push('(attribute_not_exists(stripeSubscriptionId) OR stripeSubscriptionId = :eventSubId OR #rowStatus = :cancelled)');
    names['#rowStatus'] = 'status';
    values[':eventSubId'] = guard.subscriptionId;
    values[':cancelled'] = 'cancelled';
  }
  try {
    await ddb.send(
      new UpdateCommand({
        TableName: SUBSCRIPTIONS_TABLE,
        Key: { userId },
        UpdateExpression: update.UpdateExpression.replace(/^SET /, 'SET lastStripeEventAt = :eventAt, '),
        ConditionExpression: conditions.join(' AND '),
        ExpressionAttributeNames: Object.keys(names).length ? names : undefined,
        ExpressionAttributeValues: values,
      })
    );
    return true;
  } catch (err: any) {
    if (err.name === 'ConditionalCheckFailedException') {
      console.log(`${label}: stale, duplicate or other-subscription event skipped`, { userId });
      return false;
    }
    throw err;
  }
}

/* ---------- Event handlers ---------- */

async function handleCheckoutSessionCompleted(
  session: Stripe.Checkout.Session,
  stripe: Stripe,
  eventAt: string
): Promise<void> {
  const userId = session.metadata?.userId;
  if (!userId) {
    console.warn('checkout.session.completed: no userId in metadata');
    return;
  }

  const subscriptionId = session.subscription as string;
  const customerId = session.customer as string;

  if (!subscriptionId) {
    console.warn('checkout.session.completed: no subscription on session');
    return;
  }

  // Retrieve full subscription from Stripe for period details
  const subscription = await stripe.subscriptions.retrieve(subscriptionId);

  // Safety net: ensure subscription has userId in metadata for future webhook events
  if (!subscription.metadata?.userId) {
    await stripe.subscriptions.update(subscriptionId, {
      metadata: { userId },
    });
  }

  const priceId = subscription.items.data[0]?.price.id;
  const currency = subscription.items.data[0]?.price.currency?.toUpperCase();
  const interval = subscription.items.data[0]?.price.recurring?.interval ?? null;
  const amount = subscription.items.data[0]?.price.unit_amount ?? null;
  const currentStart = unixToISO(subscription.current_period_start);
  const currentEnd = unixToISO(subscription.current_period_end);
  const timestamp = new Date().toISOString();

  await applyFresh(
    eventAt,
    {
      UpdateExpression:
        'SET currency = :currency, #interval = :interval, amount = :amount, stripeSubscriptionId = :subId, stripeCustomerId = :custId, #status = :status, planId = :planId, currentStart = :currentStart, currentEnd = :currentEnd, chargeAt = :chargeAt, paidCount = :paidCount, updatedAt = :updatedAt REMOVE checkoutSessionId, checkoutUrl, #src, periodEnd',
      ExpressionAttributeNames: { '#status': 'status', '#src': 'source', '#interval': 'interval' },
      ExpressionAttributeValues: {
        ':currency': currency ?? null,
        ':interval': interval,
        ':amount': amount,
        ':subId': subscriptionId,
        ':custId': customerId,
        ':status': subscriptionStatus(subscription),
        ':planId': priceId,
        ':currentStart': currentStart,
        ':currentEnd': currentEnd,
        ':chargeAt': currentEnd,
        ':paidCount': 1,
        ':updatedAt': timestamp,
      },
    },
    userId,
    'checkout.session.completed',
    { upsert: true }
  );

  console.log('checkout.session.completed processed', {
    userId,
    subscriptionId,
    customerId,
    priceId,
  });
}

async function handleInvoicePaid(
  invoice: Stripe.Invoice,
  stripe: Stripe,
  eventAt: string
): Promise<void> {
  const subscriptionId = invoice.subscription as string;
  if (!subscriptionId) {
    console.warn('invoice.paid: no subscription on invoice');
    return;
  }

  // Skip initial subscription creation invoice — handleCheckoutSessionCompleted handles that
  if (invoice.billing_reason === 'subscription_create') {
    console.log('invoice.paid: skipping subscription_create invoice (handled by checkout)', { subscriptionId });
    return;
  }

  // Retrieve subscription to get metadata.userId and current period
  const subscription = await stripe.subscriptions.retrieve(subscriptionId);
  const userId = subscription.metadata?.userId;

  if (!userId) {
    console.warn('invoice.paid: no userId in subscription metadata', { subscriptionId });
    return;
  }

  const currentStart = unixToISO(subscription.current_period_start);
  const currentEnd = unixToISO(subscription.current_period_end);
  const timestamp = new Date().toISOString();
  const invoiceId = invoice.id;

  await applyFresh(
    eventAt,
    {
      UpdateExpression:
        'SET paidCount = if_not_exists(paidCount, :zero) + :inc, currentStart = :currentStart, currentEnd = :currentEnd, chargeAt = :chargeAt, #status = :status, updatedAt = :updatedAt, lastInvoiceId = :invoiceId REMOVE #src, periodEnd',
      ConditionExpression: 'attribute_not_exists(lastInvoiceId) OR lastInvoiceId <> :invoiceId',
      ExpressionAttributeNames: { '#status': 'status', '#src': 'source' },
      ExpressionAttributeValues: {
        ':zero': 0,
        ':inc': 1,
        ':currentStart': currentStart,
        ':currentEnd': currentEnd,
        ':chargeAt': currentEnd,
        ':status': 'active',
        ':updatedAt': timestamp,
        ':invoiceId': invoiceId,
      },
    },
    userId,
    'invoice.paid',
    { subscriptionId }
  );

  console.log('invoice.paid processed', { userId, subscriptionId, invoiceId });
}

async function handleInvoicePaymentFailed(
  invoice: Stripe.Invoice,
  stripe: Stripe,
  eventAt: string
): Promise<void> {
  const subscriptionId = invoice.subscription as string;
  if (!subscriptionId) {
    console.warn('invoice.payment_failed: no subscription on invoice');
    return;
  }

  const subscription = await stripe.subscriptions.retrieve(subscriptionId);
  const userId = subscription.metadata?.userId;

  if (!userId) {
    console.warn('invoice.payment_failed: no userId in subscription metadata', {
      subscriptionId,
    });
    return;
  }

  const applied = await applyFresh(
    eventAt,
    {
      UpdateExpression: 'SET #status = :status, updatedAt = :updatedAt',
      ExpressionAttributeNames: { '#status': 'status' },
      ExpressionAttributeValues: {
        ':status': 'past_due',
        ':updatedAt': new Date().toISOString(),
      },
    },
    userId,
    'invoice.payment_failed',
    { subscriptionId }
  );
  if (!applied) return;

  console.log('invoice.payment_failed processed', { userId, subscriptionId });
  await notifyPaymentFailed(userId);
}

/** One mail per user per day, however many times Stripe retries; a mail problem never fails the webhook. */
async function notifyPaymentFailed(userId: string): Promise<void> {
  try {
    const today = new Date().toISOString().slice(0, 10);
    await ddb.send(
      new UpdateCommand({
        TableName: SUBSCRIPTIONS_TABLE,
        Key: { userId },
        UpdateExpression: 'SET paymentFailedEmailOn = :d',
        ConditionExpression: 'attribute_exists(userId) AND (attribute_not_exists(paymentFailedEmailOn) OR paymentFailedEmailOn <> :d)',
        ExpressionAttributeValues: { ':d': today },
      })
    );
    const to = await getUserEmail(userId);
    if (to) await sendEmail(paymentFailedMail(to));
  } catch (err: any) {
    if (err.name !== 'ConditionalCheckFailedException') console.error('payment_failed_email_error', { userId, error: err.message });
  }
}

/** Handles both customer.subscription.created and customer.subscription.updated. */
async function handleSubscriptionChanged(
  eventSubscription: Stripe.Subscription,
  stripe: Stripe,
  eventAt: string,
  label: string
): Promise<void> {
  const userId = eventSubscription.metadata?.userId;
  if (!userId) {
    console.warn(`${label}: no userId in metadata`);
    return;
  }

  // Events of one second arrive in any order and each carries its own snapshot, so write Stripe's current state.
  const subscription = await stripe.subscriptions.retrieve(eventSubscription.id);
  const status = subscriptionStatus(subscription);

  const currentPriceId = subscription.items.data[0]?.price.id;
  const updates = [
    '#status = :status',
    'updatedAt = :updatedAt',
    'currentStart = :currentStart',
    'currentEnd = :currentEnd',
    'chargeAt = :chargeAt',
    'stripeSubscriptionId = :subId',
  ];
  const values: Record<string, any> = {
    ':status': status,
    ':updatedAt': new Date().toISOString(),
    ':currentStart': unixToISO(subscription.current_period_start),
    ':currentEnd': unixToISO(subscription.current_period_end),
    ':chargeAt': unixToISO(subscription.current_period_end),
    ':subId': subscription.id,
  };
  if (currentPriceId) {
    updates.push('planId = :planId');
    values[':planId'] = currentPriceId;
    const price = subscription.items.data[0]?.price;
    updates.push('#interval = :interval', 'amount = :amount', 'currency = :currency');
    values[':interval'] = price?.recurring?.interval ?? null;
    values[':amount'] = price?.unit_amount ?? null;
    values[':currency'] = price?.currency?.toUpperCase() ?? null;
  }
  if (typeof subscription.customer === 'string') {
    updates.push('stripeCustomerId = :custId');
    values[':custId'] = subscription.customer;
  }

  await applyFresh(
    eventAt,
    {
      UpdateExpression: `SET ${updates.join(', ')} REMOVE #src, periodEnd`,
      ExpressionAttributeNames: { '#status': 'status', '#src': 'source', ...(currentPriceId ? { '#interval': 'interval' } : {}) },
      ExpressionAttributeValues: values,
    },
    userId,
    label,
    { subscriptionId: subscription.id }
  );

  console.log(`${label} processed`, {
    userId,
    subscriptionId: subscription.id,
    status,
    priceId: currentPriceId,
  });
}

async function handleSubscriptionDeleted(
  subscription: Stripe.Subscription,
  eventAt: string
): Promise<void> {
  const userId = subscription.metadata?.userId;
  if (!userId) {
    console.warn('customer.subscription.deleted: no userId in metadata');
    return;
  }

  const timestamp = new Date().toISOString();

  await applyFresh(
    eventAt,
    {
      UpdateExpression: 'SET #status = :status, endedAt = :endedAt, updatedAt = :updatedAt',
      ExpressionAttributeNames: { '#status': 'status' },
      ExpressionAttributeValues: {
        ':status': 'cancelled',
        ':endedAt': timestamp,
        ':updatedAt': timestamp,
      },
    },
    userId,
    'customer.subscription.deleted',
    { subscriptionId: subscription.id }
  );

  console.log('customer.subscription.deleted processed', {
    userId,
    subscriptionId: subscription.id,
  });
}

/* ---------- Main handler ---------- */

export const handler = async (
  event: APIGatewayProxyEvent
): Promise<APIGatewayProxyResult> => {
  try {
    console.log('Stripe webhook received', {
      httpMethod: event.httpMethod,
      path: event.path,
    });

    // Get raw body for signature verification (handle API Gateway base64 encoding)
    const rawBody = event.isBase64Encoded
      ? Buffer.from(event.body || '', 'base64').toString('utf-8')
      : (event.body || '');
    const signature =
      event.headers['stripe-signature'] || event.headers['Stripe-Signature'] || '';

    if (!signature) {
      console.error('Missing stripe-signature header');
      return errorResponse(400, ErrorCodes.MISSING_SIGNATURE, 'Missing stripe-signature header');
    }

    // Fetch secrets and construct Stripe event
    const [webhookSecret, stripe] = await Promise.all([
      getWebhookSecret(),
      getStripe(),
    ]);

    let stripeEvent: Stripe.Event;
    try {
      stripeEvent = stripe.webhooks.constructEvent(rawBody, signature, webhookSecret);
    } catch (err: any) {
      console.error('Webhook signature verification failed', { error: err.message });
      return errorResponse(400, ErrorCodes.INVALID_SIGNATURE, 'Webhook signature verification failed');
    }

    console.log('Processing Stripe event', {
      type: stripeEvent.type,
      id: stripeEvent.id,
    });

    const eventAt = stripeEvent.created ? unixToISO(stripeEvent.created) : new Date().toISOString();

    // Route events to handlers
    switch (stripeEvent.type) {
      case 'checkout.session.completed': {
        const session = stripeEvent.data.object as Stripe.Checkout.Session;
        await handleCheckoutSessionCompleted(session, stripe, eventAt);
        break;
      }

      case 'invoice.paid': {
        const invoice = stripeEvent.data.object as Stripe.Invoice;
        await handleInvoicePaid(invoice, stripe, eventAt);
        break;
      }

      case 'invoice.payment_failed': {
        const invoice = stripeEvent.data.object as Stripe.Invoice;
        await handleInvoicePaymentFailed(invoice, stripe, eventAt);
        break;
      }

      case 'customer.subscription.created':
      case 'customer.subscription.updated': {
        const subscription = stripeEvent.data.object as Stripe.Subscription;
        await handleSubscriptionChanged(subscription, stripe, eventAt, stripeEvent.type);
        break;
      }

      case 'customer.subscription.deleted': {
        const subscription = stripeEvent.data.object as Stripe.Subscription;
        await handleSubscriptionDeleted(subscription, eventAt);
        break;
      }

      default:
        console.log('Unhandled Stripe event type', { type: stripeEvent.type });
    }

    return envelope({ statusCode: 200, data: { message: 'Webhook processed successfully' }, message: 'Webhook processed successfully' });
  } catch (error: any) {
    console.error('stripe_webhook_failed', { error: error.message });
    return errorResponse(500, ErrorCodes.WEBHOOK_PROCESSING_FAILED, 'Failed to process webhook');
  }
};
