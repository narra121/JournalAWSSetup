// Shared by setup-test.mjs and create-live-prices.mjs. Secrets are read from SSM and never printed.
import { execFileSync } from 'node:child_process';
import Stripe from 'stripe';

const profile = () => process.env.AWS_PROFILE || 'personal';

function ssm(args, input) {
  return execFileSync('aws', ['ssm', ...args, '--region', 'us-east-1', '--profile', profile(), '--no-cli-pager', '--output', 'text'], {
    encoding: 'utf8',
    input,
    stdio: ['pipe', 'pipe', 'pipe'],
  }).trim();
}

export const getParam = (name) => ssm(['get-parameter', '--name', name, '--with-decryption', '--query', 'Parameter.Value']);

export const putParam = (name, value) => ssm(['put-parameter', '--name', name, '--value', value, '--type', 'String', '--overwrite']);

/** Pro catalogue (CONTRACT §4). Amounts are in the currency's smallest unit (cents, paise). */
export const PRICES = [
  { key: 'pro_month_usd', currency: 'usd', amount: 499, interval: 'month' },
  { key: 'pro_year_usd', currency: 'usd', amount: 4999, interval: 'year' },
  { key: 'pro_month_inr', currency: 'inr', amount: 49900, interval: 'month' },
  { key: 'pro_year_inr', currency: 'inr', amount: 499900, interval: 'year' },
];

export function stripeFor(secretKey, expectedPrefix) {
  if (!secretKey.startsWith(expectedPrefix)) throw new Error(`Stripe key does not start with ${expectedPrefix}; refusing to continue.`);
  return new Stripe(secretKey);
}

/** Finds or creates the Pro product, the four prices (by lookup_key) and a Customer Portal configuration. */
export async function ensureCatalog(stripe, { dryRun, returnUrl }) {
  const plan = { product: null, prices: {}, portalConfigId: null, created: [] };

  // Stripe's Search API is unavailable for this India account ("not available in your region"), so list and filter.
  const found = await stripe.products.list({ active: true, limit: 100 });
  let product = found.data.find((p) => p.metadata?.tradequt_plan === 'pro');
  if (!product) {
    plan.created.push('product TradeQut Pro');
    if (!dryRun) product = await stripe.products.create({ name: 'TradeQut Pro', metadata: { tradequt_plan: 'pro' } });
  }
  plan.product = product?.id ?? '(would create)';

  for (const p of PRICES) {
    const existing = (await stripe.prices.list({ lookup_keys: [p.key], active: true, limit: 1 })).data[0];
    if (existing) {
      plan.prices[p.key] = existing.id;
      continue;
    }
    plan.created.push(`price ${p.key} ${p.amount} ${p.currency}/${p.interval}`);
    if (!dryRun) {
      const price = await stripe.prices.create({
        product: product.id,
        currency: p.currency,
        unit_amount: p.amount,
        recurring: { interval: p.interval },
        lookup_key: p.key,
        metadata: { tradequt_plan: 'pro' },
      });
      plan.prices[p.key] = price.id;
    } else {
      plan.prices[p.key] = '(would create)';
    }
  }

  // Customer Portal (BE-E12): payment method, invoice history, cancel at period end, switch monthly <-> yearly.
  const features = {
    customer_update: { enabled: true, allowed_updates: ['email', 'name'] },
    invoice_history: { enabled: true },
    payment_method_update: { enabled: true },
    subscription_cancel: { enabled: true, mode: 'at_period_end', cancellation_reason: { enabled: true, options: ['too_expensive', 'missing_features', 'switched_service', 'unused', 'other'] } },
  };
  const priceIds = Object.values(plan.prices);
  if (product && priceIds.every((id) => !String(id).startsWith('('))) {
    features.subscription_update = {
      enabled: true,
      default_allowed_updates: ['price'],
      proration_behavior: 'create_prorations',
      products: [{ product: product.id, prices: priceIds, adjustable_quantity: { enabled: false } }],
    };
  }

  const configs = await stripe.billingPortal.configurations.list({ limit: 20 });
  const ours = configs.data.find((c) => c.metadata?.tradequt === 'portal' && c.active);
  if (ours) {
    plan.portalConfigId = ours.id;
    if (!dryRun) await stripe.billingPortal.configurations.update(ours.id, { features });
  } else {
    plan.created.push('billing portal configuration');
    if (!dryRun) {
      const created = await stripe.billingPortal.configurations.create({
        business_profile: { headline: 'Manage your TradeQut Pro subscription' },
        default_return_url: returnUrl,
        metadata: { tradequt: 'portal' },
        features,
      });
      plan.portalConfigId = created.id;
    } else {
      plan.portalConfigId = '(would create)';
    }
  }
  return plan;
}

export function writeParams(stage, plan) {
  for (const [key, id] of Object.entries(plan.prices)) putParam(`/tradequt/${stage}/stripe/price/${key}`, id);
  if (plan.portalConfigId) putParam(`/tradequt/${stage}/stripe/portalConfigId`, plan.portalConfigId);
}
