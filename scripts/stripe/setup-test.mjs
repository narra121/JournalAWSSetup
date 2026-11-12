// Creates the Pro product, 4 prices and the Customer Portal configuration in Stripe TEST mode and records the ids
// in dev SSM (/tradequt/dev/stripe/price/pro_*, /tradequt/dev/stripe/portalConfigId). Idempotent (lookup keys).
// Usage: node scripts/stripe/setup-test.mjs [--dry-run]
import { ensureCatalog, getParam, stripeFor, writeParams } from './lib.mjs';

const dryRun = process.argv.includes('--dry-run');
const stripe = stripeFor(getParam('/tradequt/dev/stripeSecretKey'), 'sk_test_');
const plan = await ensureCatalog(stripe, { dryRun, returnUrl: 'https://dev.tradequt.com/app/billing' });

if (!dryRun) writeParams('dev', plan);
console.log(JSON.stringify({ mode: 'test', dryRun, ...plan }, null, 2));
