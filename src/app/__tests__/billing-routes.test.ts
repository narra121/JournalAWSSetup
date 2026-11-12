import { GetParameterCommand, SSMClient } from '@aws-sdk/client-ssm';
import { DynamoDBDocumentClient, GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { mockClient } from 'aws-sdk-client-mock';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.stubEnv('USER_POOL_ID', 'us-east-1_t');
vi.stubEnv('USER_POOL_CLIENT_ID', 'c');
vi.stubEnv('ALLOWED_ORIGINS', 'https://dev.tradequt.com,http://localhost:8080');
vi.stubEnv('SUBSCRIPTIONS_TABLE', 'subs');
vi.stubEnv('STAGE_NAME', 'dev');
vi.stubEnv('STRIPE_SECRET_KEY_PARAM', '/tradequt/dev/stripeSecretKey');

const ddb = mockClient(DynamoDBDocumentClient);
const ssm = mockClient(SSMClient);
const { createApp } = await import('../app');
const { setTokenVerifier } = await import('../auth/cognito');
const { clearBillingCache, setStripeClient } = await import('../billing/stripe');

const sessionsCreate = vi.fn();
const portalCreate = vi.fn();
const app = createApp();
const headers = { authorization: 'Bearer good', 'content-type': 'application/json', origin: 'https://dev.tradequt.com' };
const post = (path: string, body?: unknown, extra: Record<string, string> = {}) =>
  app.request(path, { method: 'POST', headers: { ...headers, ...extra }, body: body === undefined ? undefined : JSON.stringify(body) });

beforeEach(() => {
  ddb.reset();
  ssm.reset();
  clearBillingCache();
  sessionsCreate.mockReset().mockResolvedValue({ id: 'cs_test_1', url: 'https://checkout.stripe.com/c/pay/cs_test_1' });
  portalCreate.mockReset().mockResolvedValue({ url: 'https://billing.stripe.com/p/session/x' });
  setStripeClient({ checkout: { sessions: { create: sessionsCreate } }, billingPortal: { sessions: { create: portalCreate } } } as any);
  setTokenVerifier({ verify: async () => ({ sub: 'u1', email: 'u@x.y' }) });
  ddb.on(GetCommand).resolves({ Item: { userId: 'u1', status: 'trial', trialEnd: new Date(Date.now() + 86400000).toISOString() } });
  ddb.on(UpdateCommand).resolves({});
  ssm.on(GetParameterCommand).callsFake(({ Name }) => {
    if (Name.includes('/price/pro_')) return { Parameter: { Value: `price_${Name.split('/').pop()}` } };
    if (Name.endsWith('portalConfigId')) return { Parameter: { Value: 'bpc_1' } };
    return Promise.reject(Object.assign(new Error('nf'), { name: 'ParameterNotFound' }));
  });
});

describe('POST /v1/billing/checkout', () => {
  it.each([
    ['month', 'price_pro_month_usd'],
    ['year', 'price_pro_year_usd'],
  ])('returns a Stripe Checkout url for %s (USD by default)', async (interval, price) => {
    const res = await post('/v1/billing/checkout', { interval });
    expect(res.status).toBe(200);
    expect((await res.json()).data.url).toContain('checkout.stripe.com');
    const args = sessionsCreate.mock.calls[0][0];
    expect(args).toMatchObject({
      mode: 'subscription',
      line_items: [{ price, quantity: 1 }],
      allow_promotion_codes: true,
      client_reference_id: 'u1',
      customer_email: 'u@x.y',
      metadata: { userId: 'u1', interval },
      success_url: 'https://dev.tradequt.com/app/billing?session_id={CHECKOUT_SESSION_ID}',
      cancel_url: 'https://dev.tradequt.com/app/billing?checkout=cancelled',
    });
    expect(args.subscription_data.trial_period_days).toBeUndefined();
  });

  it('uses INR prices for viewers in India', async () => {
    await post('/v1/billing/checkout', { interval: 'month' }, { 'cloudfront-viewer-country': 'IN' });
    expect(sessionsCreate.mock.calls[0][0].line_items[0].price).toBe('price_pro_month_inr');
  });

  it('keeps the currency of an existing Stripe customer and reuses the customer', async () => {
    ddb.on(GetCommand).resolves({ Item: { userId: 'u1', status: 'cancelled', stripeCustomerId: 'cus_1', currency: 'INR' } });
    await post('/v1/billing/checkout', { interval: 'year' });
    const args = sessionsCreate.mock.calls[0][0];
    expect(args.line_items[0].price).toBe('price_pro_year_inr');
    expect(args.customer).toBe('cus_1');
    expect(args.customer_email).toBeUndefined();
  });

  it('falls back to the stage first origin for an unknown Origin', async () => {
    await post('/v1/billing/checkout', { interval: 'month' }, { origin: 'https://evil.example' });
    expect(sessionsCreate.mock.calls[0][0].success_url.startsWith('https://dev.tradequt.com/')).toBe(true);
  });

  it('records the session without changing status or trialEnd', async () => {
    await post('/v1/billing/checkout', { interval: 'month' });
    const input = ddb.commandCalls(UpdateCommand)[0].args[0].input;
    expect(input.UpdateExpression).toBe('SET checkoutSessionId = :s, checkoutUrl = :u, updatedAt = :now');
  });

  it('rejects a bad interval with 400 and an active subscriber with 409 ALREADY_SUBSCRIBED', async () => {
    expect((await post('/v1/billing/checkout', { interval: 'week' })).status).toBe(400);
    expect((await post('/v1/billing/checkout')).status).toBe(400);
    ddb.on(GetCommand).resolves({ Item: { userId: 'u1', status: 'active' } });
    const res = await post('/v1/billing/checkout', { interval: 'month' });
    expect(res.status).toBe(409);
    expect((await res.json()).errorCode).toBe('ALREADY_SUBSCRIBED');
  });

  it('requires authentication', async () => {
    setTokenVerifier({ verify: async () => Promise.reject(new Error('bad')) });
    expect((await post('/v1/billing/checkout', { interval: 'month' })).status).toBe(401);
  });
});

describe('POST /v1/billing/portal', () => {
  it('400 NO_BILLING_ACCOUNT before the first subscription', async () => {
    const res = await post('/v1/billing/portal');
    expect(res.status).toBe(400);
    expect((await res.json()).errorCode).toBe('NO_BILLING_ACCOUNT');
  });

  it('returns a portal url for a customer, with our configuration and /app/billing return url', async () => {
    ddb.on(GetCommand).resolves({ Item: { userId: 'u1', status: 'active', stripeCustomerId: 'cus_1' } });
    const res = await post('/v1/billing/portal');
    expect(res.status).toBe(200);
    expect((await res.json()).data.url).toContain('billing.stripe.com');
    expect(portalCreate.mock.calls[0][0]).toEqual({
      customer: 'cus_1',
      return_url: 'https://dev.tradequt.com/app/billing',
      configuration: 'bpc_1',
    });
  });
});
