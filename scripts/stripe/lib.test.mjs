// Run: node --test scripts/stripe/lib.test.mjs   (vitest only collects src/**, so this uses node:test)
import test from 'node:test';
import assert from 'node:assert/strict';
import { ensureCatalog, PRICES } from './lib.mjs';

const PRODUCT = { id: 'prod_pro', metadata: { tradequt_plan: 'pro' } };
const OPTS = { dryRun: false, returnUrl: 'https://example.test/billing' };

const priceFor = (p, overrides = {}) => ({
  id: `price_${p.key}`,
  lookup_key: p.key,
  currency: p.currency,
  unit_amount: p.amount,
  recurring: { interval: p.interval },
  ...overrides,
});

function fakeStripe(existingByKey) {
  const calls = [];
  const stripe = {
    products: { list: async () => ({ data: [PRODUCT] }), create: async () => assert.fail('product must not be created') },
    prices: {
      list: async ({ lookup_keys }) => ({ data: existingByKey[lookup_keys[0]] ? [existingByKey[lookup_keys[0]]] : [] }),
      create: async (params) => {
        calls.push(['create', params]);
        return { id: `new_${params.lookup_key}` };
      },
      update: async (id, params) => {
        calls.push(['update', id, params]);
        return { id };
      },
    },
    billingPortal: { configurations: { list: async () => ({ data: [{ id: 'bpc_1', active: true, metadata: { tradequt: 'portal' } }] }), update: async () => ({}) } },
  };
  return { stripe, calls };
}

const matching = () => Object.fromEntries(PRICES.map((p) => [p.key, priceFor(p)]));

test('reuses a price whose amount, currency and interval all match', async () => {
  const { stripe, calls } = fakeStripe(matching());
  const plan = await ensureCatalog(stripe, OPTS);
  assert.deepEqual(calls, []);
  assert.deepEqual(plan.created, []);
  assert.equal(plan.prices.pro_month_usd, 'price_pro_month_usd');
});

for (const [label, overrides] of [
  ['amount', { unit_amount: 999 }],
  ['currency', { currency: 'eur' }],
  ['interval', { recurring: { interval: 'year' } }],
]) {
  test(`a lookup_key price with a different ${label} is replaced and archived`, async () => {
    const existing = matching();
    existing.pro_month_usd = priceFor(PRICES[0], overrides);
    const { stripe, calls } = fakeStripe(existing);

    const plan = await ensureCatalog(stripe, OPTS);

    assert.deepEqual(calls, [
      ['create', { product: 'prod_pro', currency: 'usd', unit_amount: 499, recurring: { interval: 'month' }, lookup_key: 'pro_month_usd', transfer_lookup_key: true, metadata: { tradequt_plan: 'pro' } }],
      ['update', 'price_pro_month_usd', { active: false }],
    ]);
    assert.equal(plan.prices.pro_month_usd, 'new_pro_month_usd');
    assert.equal(plan.created.length, 1);
  });
}

test('a dry run reports the replacement and changes nothing', async () => {
  const existing = matching();
  existing.pro_year_inr = priceFor(PRICES[3], { unit_amount: 149900 });
  const { stripe, calls } = fakeStripe(existing);

  const plan = await ensureCatalog(stripe, { ...OPTS, dryRun: true });

  assert.deepEqual(calls, []);
  assert.equal(plan.created.length, 1);
  assert.match(plan.created[0], /pro_year_inr/);
  assert.equal(plan.prices.pro_year_inr, '(would create)');
});

test('a missing price is created with the lookup key transferred', async () => {
  const existing = matching();
  delete existing.pro_month_inr;
  const { stripe, calls } = fakeStripe(existing);

  await ensureCatalog(stripe, OPTS);

  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], 'create');
  assert.equal(calls[0][1].transfer_lookup_key, true);
});
