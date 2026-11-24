# Stripe live setup

**Historical for the first run, still the procedure for a price change.** The live product, prices and portal configuration were
created in live mode on 2026-11-13: `/tradequt/prod/stripe/price/pro_*` and `/tradequt/prod/stripe/portalConfigId` exist in SSM.
The four Pro prices (two currencies, month and year) are the `PRICES` table in `scripts/stripe/lib.mjs`; display copies are in
`PLAN_CONFIG` of `src/handlers/get-subscription-plans/app.ts` and in the frontend. Currency follows the viewer country
(`CloudFront-Viewer-Country: IN` → INR, otherwise USD) and an existing Stripe customer keeps their currency.

`scripts/stripe/create-live-prices.mjs` is a dry run unless `--live --confirm` is given and it
refuses to run unless the key in SSM starts with `sk_live_`.

A price change touches more than Stripe: see [../ARCHITECTURE.md](../ARCHITECTURE.md) section 10e.

## Before you run it

1. The Stripe account is activated for the countries you sell in (the owner's business check).
2. `/tradequt/prod/stripeSecretKey` holds the **live** secret key (SecureString) and `/tradequt/prod/stripeWebhookSecret`
   the live webhook signing secret.
3. AWS credentials (profile `personal`) with read/write on `/tradequt/prod/stripe/*`.

## Steps

```
node scripts/stripe/create-live-prices.mjs                    # dry run: lists what would be created
node scripts/stripe/create-live-prices.mjs --live --confirm   # creates the product, 4 prices, the portal configuration, writes SSM
```
Creates (idempotent, found again by lookup key): product `TradeQut Pro`, the four prices with lookup keys `pro_month_usd`,
`pro_year_usd`, `pro_month_inr`, `pro_year_inr`, and a Customer Portal configuration (update payment method, invoice history, cancel at
period end, switch monthly ↔ yearly, customer e-mail/name). Writes `/tradequt/prod/stripe/price/pro_*` and
`/tradequt/prod/stripe/portalConfigId`. Re-running updates the portal configuration. A price under one of these lookup keys whose
amount, currency or interval differs from the catalogue is replaced: a new price takes over the key and the old one is archived.

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
subscribers are not affected. A subscription on a price that is no longer one of the current Pro prices keeps working and is
flagged `legacyPrice` in the entitlements.

## Dev (test mode)

`node scripts/stripe/setup-test.mjs [--dry-run]` does the same with a `sk_test_` key (read from `/tradequt/dev/stripeSecretKey`) and
writes `/tradequt/dev/stripe/*`. If Stripe rejects the key, put a new test key in that parameter first.
