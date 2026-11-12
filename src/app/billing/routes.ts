import { UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { Hono } from 'hono';
import { ddb } from '../../shared/dynamo';
import type { AppEnv } from '../types';
import { saveWritableAccounts } from './accounts';
import { computeEntitlements } from './entitlements';
import { periodResetsAt, readUsage } from './quota';
import { allProPriceIds, checkoutOrigin, getStripe, portalConfigId, proPriceId, type Currency, type Interval } from './stripe';

export const meRoutes = new Hono<AppEnv>();
export const billingRoutes = new Hono<AppEnv>();

/** INR for viewers CloudFront geolocates to India, USD otherwise. */
export function billingCurrencyFor(country: string | undefined): Currency {
  return country?.toUpperCase() === 'IN' ? 'INR' : 'USD';
}

/** A customer already billed in a currency keeps it (Stripe fixes the currency per customer). */
function currencyFor(c: { req: { header(n: string): string | undefined }; get(k: 'subscription'): Record<string, any> | undefined }): Currency {
  const stored = c.get('subscription')?.currency;
  if (stored === 'INR' || stored === 'USD') return stored;
  return billingCurrencyFor(c.req.header('cloudfront-viewer-country'));
}

const fail = (c: any, status: number, code: string, message: string) =>
  c.json({ success: false, message, errorCode: code, errorMessage: message }, status);

meRoutes.get('/me/entitlements', async (c) => {
  const usage = await readUsage(c.get('userId'));
  const sub = c.get('subscription');
  // Re-derived with the current price ids so a subscription on an older price is flagged `legacyPrice`.
  const entitlements = sub?.planId ? computeEntitlements(sub, new Date(), await allProPriceIds()) : c.get('entitlements');
  return c.json({
    success: true,
    message: 'Success',
    data: {
      entitlements,
      usage,
      periodResetsAt: periodResetsAt(),
      billingCurrency: currencyFor(c),
      writableAccountIds: c.get('subscription')?.writableAccountIds ?? null,
    },
  });
});

meRoutes.put('/me/writable-accounts', async (c) => {
  const body: any = await c.req.json().catch(() => null);
  return saveWritableAccounts(c, body?.accountIds);
});

billingRoutes.post('/billing/checkout', async (c) => {
  let body: any;
  try {
    body = await c.req.json();
  } catch {
    body = null;
  }
  const interval = body?.interval as Interval;
  if (interval !== 'month' && interval !== 'year') {
    return fail(c, 400, 'VALIDATION_ERROR', "interval must be 'month' or 'year'");
  }

  const sub = c.get('subscription');
  if (c.get('entitlements').plan === 'pro' && sub?.status !== 'cancellation_requested') {
    return fail(c, 409, 'ALREADY_SUBSCRIBED', 'You already have an active Pro subscription.');
  }

  const priceId = await proPriceId(interval, currencyFor(c));
  if (!priceId) return fail(c, 503, 'PRICE_NOT_CONFIGURED', 'Pro pricing is not configured.');

  const userId = c.get('userId');
  const origin = checkoutOrigin(c.req.header('origin'));
  const stripe = await getStripe();
  const session = await stripe.checkout.sessions.create({
    mode: 'subscription',
    line_items: [{ price: priceId, quantity: 1 }],
    allow_promotion_codes: true,
    client_reference_id: userId,
    ...(sub?.stripeCustomerId ? { customer: sub.stripeCustomerId } : { customer_email: c.get('email') }),
    metadata: { userId, interval },
    subscription_data: { metadata: { userId, planId: priceId } },
    success_url: `${origin}/app/billing?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${origin}/app/billing?checkout=cancelled`,
  });

  // Record the session without touching status or trialEnd: the user keeps the trial until payment succeeds.
  await ddb.send(
    new UpdateCommand({
      TableName: process.env.SUBSCRIPTIONS_TABLE!,
      Key: { userId },
      UpdateExpression: 'SET checkoutSessionId = :s, checkoutUrl = :u, updatedAt = :now',
      ExpressionAttributeValues: { ':s': session.id, ':u': session.url, ':now': new Date().toISOString() },
    }),
  );
  return c.json({ success: true, message: 'Success', data: { url: session.url } });
});

billingRoutes.post('/billing/portal', async (c) => {
  const customer = c.get('subscription')?.stripeCustomerId;
  if (!customer) return fail(c, 400, 'NO_BILLING_ACCOUNT', 'No billing account yet. Subscribe first.');

  const stripe = await getStripe();
  const configuration = await portalConfigId();
  const session = await stripe.billingPortal.sessions.create({
    customer,
    return_url: `${checkoutOrigin(c.req.header('origin'))}/app/billing`,
    ...(configuration ? { configuration } : {}),
  });
  return c.json({ success: true, message: 'Success', data: { url: session.url } });
});
