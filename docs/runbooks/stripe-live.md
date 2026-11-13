# Stripe live setup (owner approved 2026-11-11; run by the main thread at the cut-over)

Pro prices (CONTRACT §4): **$4.99/month, $49.99/year, ₹499/month, ₹4,999/year** (created in live mode 2026-11-13). Currency follows the viewer country
(`CloudFront-Viewer-Country: IN` → INR, otherwise USD) and an existing Stripe customer keeps their currency.

Nothing here has been executed. `scripts/stripe/create-live-prices.mjs` is a dry run unless `--live --confirm` is given and it
refuses to run unless the key in SSM starts with `sk_live_`.

## Before you run it

1. Stripe account is activated for India (Stripe India eligibility/KYC is the owner's business check — decision D-10).
2. `/tradequt/prod/stripeSecretKey` holds the **live** secret key (SecureString) and `/tradequt/prod/stripeWebhookSecret`
   the live webhook signing secret.
3. AWS credentials with read/write on `/tradequt/prod/stripe/*` (the cut-over operator).

## Steps

```
node scripts/stripe/create-live-prices.mjs                    # dry run: lists what would be created
node scripts/stripe/create-live-prices.mjs --live --confirm   # creates the product, 4 prices, the portal configuration, writes SSM
```
Creates (idempotent, found again by lookup key): product `TradeQut Pro`, prices `pro_month_usd`, `pro_year_usd`,
`pro_month_inr`, `pro_year_inr`, and a Customer Portal configuration (update payment method, invoice history, cancel at
period end, switch monthly ↔ yearly, customer e-mail/name). Writes `/tradequt/prod/stripe/price/pro_*` and
`/tradequt/prod/stripe/portalConfigId`. Re-running updates the portal configuration.

Webhook endpoint (dashboard → Developers → Webhooks): `https://api.tradequt.com/v1/payments/webhook` with events
`checkout.session.completed`, `customer.subscription.created`, `customer.subscription.updated`,
`customer.subscription.deleted`, `invoice.paid`, `invoice.payment_failed`. The signing secret goes to
`/tradequt/prod/stripeWebhookSecret`.

Optional (owner): switch on Stripe's own receipt and failed-payment e-mails (Settings → Billing → Subscriptions and emails);
our payment-failed mail is sent at most once a day in addition.

## Verification

1. `aws ssm get-parameters-by-path --path /tradequt/prod/stripe --query "Parameters[].Name"` lists the four prices and the portal id.
2. `GET https://api.tradequt.com/v1/subscriptions/plans` returns the four plans (and `?currency=INR` the rupee ones).
3. Signed in: `POST /v1/billing/checkout {"interval":"year"}` returns a `cs_live_…` URL (do not pay) and
   `POST /v1/billing/portal` answers `400 NO_BILLING_ACCOUNT` before a first purchase.
4. One real small purchase by the owner, refunded afterwards: the webhook flips the user to `active` (`/v1/me/entitlements`
   shows `plan: pro`, `status: active`, interval, amount, `renewsAt`); cancelling in the portal shows `canceling` with `endsAt`.

## Rollback

Prices cannot be deleted in Stripe; archive them (`stripe prices update <id> --active=false`) and remove the SSM parameters
(`aws ssm delete-parameter`). Checkout then answers `503 PRICE_NOT_CONFIGURED` and the plans list is empty; existing
subscribers are not affected. Legacy subscriptions on the old $1.99/₹99 prices keep working and are flagged `legacyPrice`.

## Dev (test mode)

`node scripts/stripe/setup-test.mjs` does the same with a `sk_test_` key and writes `/tradequt/dev/stripe/*`. The dev key in SSM
expired on 2026-11-11 (ACCESS-NEEDED #9); put a new test key first.
