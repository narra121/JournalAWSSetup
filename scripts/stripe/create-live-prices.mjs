// LIVE Stripe: creates the Pro product, 4 prices and the Customer Portal configuration, then writes prod SSM
// (/tradequt/prod/stripe/price/pro_*, /tradequt/prod/stripe/portalConfigId). Dry-run by default.
// Usage:
//   node scripts/stripe/create-live-prices.mjs                 # lists what would be created, writes nothing
//   node scripts/stripe/create-live-prices.mjs --live --confirm  # creates live objects and prod SSM parameters
// Runbook: docs/runbooks/stripe-live.md. Needs prod SSM read/write (AWS_PROFILE with access to the prod parameters).
import { ensureCatalog, getParam, stripeFor, writeParams } from './lib.mjs';

const live = process.argv.includes('--live');
const confirmed = process.argv.includes('--confirm');
if (live && !confirmed) throw new Error('--live needs --confirm');

const stripe = stripeFor(getParam('/tradequt/prod/stripeSecretKey'), 'sk_live_');
const dryRun = !(live && confirmed);
const plan = await ensureCatalog(stripe, { dryRun, returnUrl: 'https://tradequt.com/app/billing' });

if (!dryRun) writeParams('prod', plan);
console.log(JSON.stringify({ mode: 'live', dryRun, ...plan }, null, 2));
if (dryRun) console.log('Nothing was created. Re-run with --live --confirm to apply.');
