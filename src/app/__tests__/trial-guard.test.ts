import { CognitoIdentityProviderClient } from '@aws-sdk/client-cognito-identity-provider';
import { S3Client } from '@aws-sdk/client-s3';
import { GetParameterCommand, SSMClient } from '@aws-sdk/client-ssm';
import { DynamoDBDocumentClient, GetCommand, QueryCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { mockClient } from 'aws-sdk-client-mock';
import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppEnv } from '../types';

vi.stubEnv('USER_POOL_ID', 'us-east-1_t');
vi.stubEnv('USER_POOL_CLIENT_ID', 'c');
vi.stubEnv('ALLOWED_ORIGINS', 'https://dev.tradequt.com');
vi.stubEnv('SUBSCRIPTIONS_TABLE', 'subs');
vi.stubEnv('USAGE_TABLE', 'usage');
vi.stubEnv('AI_DATA_TABLE', 'ai');
vi.stubEnv('IMAGES_BUCKET', 'images');
vi.stubEnv('STRIPE_SECRET_KEY_PARAM', '/tradequt/dev/stripeSecretKey');

// Every legacy handler and every feature route is a stub, so the test sees only the chain createApp puts in front of them.
const reached = vi.fn();
const stub = (...args: any[]) => {
  reached(...args);
  return { statusCode: 200, body: JSON.stringify({ success: true, data: {} }) };
};
vi.mock('../../handlers/admin-delete-user/app', () => ({ handler: stub }));
vi.mock('../../handlers/admin-get-config/app', () => ({ handler: stub }));
vi.mock('../../handlers/admin-get-user/app', () => ({ handler: stub }));
vi.mock('../../handlers/admin-get-user-stats/app', () => ({ handler: stub }));
vi.mock('../../handlers/admin-list-user-trades/app', () => ({ handler: stub }));
vi.mock('../../handlers/admin-list-users/app', () => ({ handler: stub }));
vi.mock('../../handlers/admin-login/app', () => ({ handler: stub }));
vi.mock('../../handlers/admin-manage-subscription/app', () => ({ handler: stub }));
vi.mock('../../handlers/admin-update-config/app', () => ({ handler: stub }));
vi.mock('../../handlers/admin-update-user/app', () => ({ handler: stub }));
vi.mock('../../handlers/auth-confirm-forgot-password/app', () => ({ handler: stub }));
vi.mock('../../handlers/auth-confirm-signup/app', () => ({ handler: stub }));
vi.mock('../../handlers/auth-forgot-password/app', () => ({ handler: stub }));
vi.mock('../../handlers/auth-login/app', () => ({ handler: stub }));
vi.mock('../../handlers/auth-refresh/app', () => ({ handler: stub }));
vi.mock('../../handlers/auth-signup/app', () => ({ handler: stub }));
vi.mock('../../handlers/bulk-delete-trades/app', () => ({ handler: stub }));
vi.mock('../../handlers/bulk-update-trades/app', () => ({ handler: stub }));
vi.mock('../../handlers/create-account/app', () => ({ handler: stub }));
vi.mock('../../handlers/create-goal/app', () => ({ handler: stub }));
vi.mock('../../handlers/create-rule/app', () => ({ handler: stub }));
vi.mock('../../handlers/create-stripe-checkout/app', () => ({ handler: stub }));
vi.mock('../../handlers/create-trade/app', () => ({ handler: stub }));
vi.mock('../../handlers/delete-account/app', () => ({ handler: stub }));
vi.mock('../../handlers/delete-rule/app', () => ({ handler: stub }));
vi.mock('../../handlers/delete-trade/app', () => ({ handler: stub }));
vi.mock('../../handlers/enhance-text/app', () => ({ handler: stub }));
vi.mock('../../handlers/extract-trades/app', () => ({ handler: stub }));
vi.mock('../../handlers/get-ad-config/app', () => ({ handler: stub }));
vi.mock('../../handlers/get-trade/app', () => ({ handler: stub }));
vi.mock('../../handlers/get-goals-progress/app', async (orig) => ({ ...(await orig<object>()), handler: stub }));
vi.mock('../../handlers/get-image/app', () => ({ handler: stub }));
vi.mock('../../handlers/get-rules-goals/app', () => ({ handler: stub }));
vi.mock('../../handlers/get-saved-options/app', () => ({ handler: stub }));
vi.mock('../../handlers/get-stats/app', () => ({ handler: stub }));
vi.mock('../../handlers/get-subscription-plans/app', () => ({ handler: stub }));
vi.mock('../../handlers/get-user-profile/app', () => ({ handler: stub }));
vi.mock('../../handlers/list-accounts/app', () => ({ handler: stub }));
vi.mock('../../handlers/list-rules/app', () => ({ handler: stub }));
vi.mock('../../handlers/list-trades/app', () => ({ handler: stub }));
vi.mock('../../handlers/manage-stripe-subscription/app', () => ({ handler: stub }));
vi.mock('../../handlers/report-error/app', () => ({ handler: stub }));
vi.mock('../../handlers/stripe-webhook/app', () => ({ handler: stub }));
vi.mock('../../handlers/restore-trades/app', () => ({ handler: stub }));
vi.mock('../../handlers/sync-trades/app', () => ({ handler: stub }));
vi.mock('../../handlers/update-account/app', () => ({ handler: stub }));
vi.mock('../../handlers/update-account-status/app', () => ({ handler: stub }));
vi.mock('../../handlers/update-goal/app', () => ({ handler: stub }));
vi.mock('../../handlers/update-rule/app', () => ({ handler: stub }));
vi.mock('../../handlers/update-saved-options/app', () => ({ handler: stub }));
vi.mock('../../handlers/update-trade/app', () => ({ handler: stub }));
vi.mock('../../handlers/update-user-notifications/app', () => ({ handler: stub }));
vi.mock('../../handlers/update-user-preferences/app', () => ({ handler: stub }));
vi.mock('../../handlers/update-user-profile/app', () => ({ handler: stub }));
vi.mock('../../handlers/verify-checkout-session/app', () => ({ handler: stub }));
vi.mock('../../shared/account-data', () => ({
  exportUserData: async () => ({ exportVersion: 1, exportedAt: '2026-11-13T00:00:00.000Z' }),
  purgeUser: async () => ({ deleted: {} }),
}));
vi.mock('@aws-sdk/s3-request-presigner', () => ({ getSignedUrl: async () => 'https://images.s3.amazonaws.com/signed' }));

const ddb = mockClient(DynamoDBDocumentClient);
vi.spyOn(S3Client.prototype, 'send').mockResolvedValue({ Contents: [], IsTruncated: false } as never);
mockClient(CognitoIdentityProviderClient).resolves({ Users: [{ Username: 'u1' }] });
const ssm = mockClient(SSMClient);
const { createApp } = await import('../app');
const { setTokenVerifier } = await import('../auth/cognito');
const { setStripeClient, clearBillingCache } = await import('../billing/stripe');
const { featureRoutes } = await import('../../features/index');
const { LEGACY_ROUTES, toHonoPath } = await import('../routes');

/** The real feature paths and methods, each answered by a stub. */
const stubFeatures = featureRoutes.map(({ basePath, app }) => {
  const s = new Hono<AppEnv>();
  for (const r of app.routes) {
    if (r.method === 'ALL') continue;
    s.on(r.method, r.path, (c) => {
      reached();
      return c.json({ success: true, data: {} });
    });
  }
  return { basePath, app: s };
});
const app = createApp({ featureRoutes: stubFeatures });

const unsafe = (m: string) => !['GET', 'HEAD', 'OPTIONS', 'ALL'].includes(m);
const legacyKey = (r: { method: string; path: string }) => `${r.method} ${toHonoPath(r.path)}`;
const publicOrAdmin = new Set(LEGACY_ROUTES.filter((r) => r.auth !== 'cognito').map(legacyKey));
/** Every write route a signed-in user can call: legacy cognito routes, the native routes and the feature apps. */
const writes = [...new Set(app.routes.filter((r) => unsafe(r.method)).map((r) => `${r.method} ${r.path}`))].filter((k) => !publicOrAdmin.has(k));

const GUARDED = [
  'POST /v1/accounts', 'DELETE /v1/accounts/:accountId', 'PUT /v1/accounts/:accountId', 'PATCH /v1/accounts/:accountId/status',
  'POST /v1/enhance-text', 'POST /v1/goals', 'PUT /v1/goals/:goalId', 'PUT /v1/options',
  'POST /v1/rules', 'DELETE /v1/rules/:ruleId', 'PUT /v1/rules/:ruleId',
  'POST /v1/trades', 'POST /v1/trades/bulk-delete', 'POST /v1/trades/bulk-update', 'POST /v1/trades/extract', 'POST /v1/trades/restore', 'POST /v1/trades/sync',
  'DELETE /v1/trades/:tradeId', 'PUT /v1/trades/:tradeId', 'PUT /v1/user/preferences', 'PUT /v1/user/profile',
  'POST /v1/uploads/images', 'PUT /v1/journal/days/:date',
  'POST /v1/import/parse', 'POST /v1/insights/generate', 'PUT /v1/insights/settings', 'POST /v1/insights/:id/feedback',
  'PUT /v1/insights/focus', 'DELETE /v1/insights/focus',
  'POST /v1/chat/sessions', 'DELETE /v1/chat/sessions/:id', 'POST /v1/chat/sessions/:id/messages',
];
const EXEMPT = [
  'DELETE /v1/subscriptions', 'PATCH /v1/subscriptions', 'POST /v1/subscriptions', 'PUT /v1/subscriptions', 'PUT /v1/user/notifications',
  'DELETE /v1/auth/account', 'POST /v1/auth/logout-all', 'POST /v1/billing/checkout', 'POST /v1/billing/portal',
  'POST /v1/analysis/what-if', 'POST /v1/analysis/query',
];
const NATIVE = new Set(['POST /v1/uploads/images', 'PUT /v1/journal/days/:date']);
const READS = ['/v1/trades', '/v1/accounts', '/v1/stats?sections=advanced', '/v1/auth/export', '/v1/insights', '/v1/chat/sessions', '/v1/me/entitlements', '/v1/analysis', '/v1/reports/tax'];

const day = 86_400_000;
const iso = (offset: number) => new Date(Date.now() + offset).toISOString();
const PLANS: Record<string, Record<string, unknown>> = {
  expired: { userId: 'u1', status: 'trial', trialEnd: iso(-day), stripeCustomerId: 'cus_1', plansVersion: 2 },
  lapsedPro: { userId: 'u1', status: 'cancelled', trialEnd: iso(-60 * day), stripeCustomerId: 'cus_1', stripeSubscriptionId: 'sub_1', endedAt: iso(-day), plansVersion: 2 },
  trial: { userId: 'u1', status: 'trial', trialEnd: iso(5 * day), plansVersion: 2 },
  pro: { userId: 'u1', status: 'active', stripeSubscriptionId: 'sub_1', plansVersion: 2 },
};
let subscription: Record<string, unknown>;

const concrete = (path: string) => path.replace(/:(\w+)(\{[^}]+\})?/g, (_m, name: string) => (name === 'date' ? '2026-11-12' : 'x1'));
const auth = { authorization: 'Bearer good', origin: 'https://dev.tradequt.com' };
const send = (route: string) => {
  const [method, path] = route.split(' ');
  return app.request(concrete(path), {
    method,
    headers: { ...auth, 'content-type': 'application/json' },
    body: JSON.stringify({ interval: 'year', contentType: 'image/png', size: 1000 }),
  });
};

beforeEach(() => {
  ddb.reset();
  ssm.reset();
  clearBillingCache();
  reached.mockReset();
  setTokenVerifier({ verify: async () => ({ sub: 'u1', email: 'u@x.y' }) });
  setStripeClient({
    checkout: { sessions: { create: async () => ({ id: 'cs_1', url: 'https://checkout.stripe.com/x' }) } },
    billingPortal: { sessions: { create: async () => ({ url: 'https://billing.stripe.com/x' }) } },
  } as any);
  ssm.on(GetParameterCommand).resolves({ Parameter: { Value: 'price_1' } });
  ddb.on(GetCommand).callsFake((input) => (input.TableName === 'subs' ? { Item: subscription } : {}));
  ddb.on(QueryCommand).resolves({ Items: [] });
  ddb.on(UpdateCommand).resolves({});
});

describe('read-only guard: route inventory', () => {
  it('classifies every signed-in write route (a new one fails here until it is listed)', () => {
    expect([...writes].sort()).toEqual([...GUARDED, ...EXEMPT].sort());
  });
});

describe.each(['expired', 'lapsedPro'])('read-only user (%s)', (plan) => {
  beforeEach(() => {
    subscription = { ...PLANS[plan] };
  });

  // A former Pro user is not told about a free trial.
  const message = plan === 'lapsedPro' ? 'Your Pro plan has ended. Upgrade to Pro to add, edit or delete.' : 'Your free trial has ended. Upgrade to Pro to add, edit or delete.';

  it.each(GUARDED)('%s → 402 TRIAL_EXPIRED, handler not called', async (route) => {
    const res = await send(route);
    expect(res.status).toBe(402);
    expect(await res.json()).toEqual({ success: false, errorCode: 'TRIAL_EXPIRED', message, errorMessage: message });
    expect(reached).not.toHaveBeenCalled();
  });

  it.each(EXEMPT)('%s stays allowed', async (route) => {
    const res = await send(route);
    expect(res.status).not.toBe(402);
    expect(res.status).toBeLessThan(400);
  });

  it.each(READS)('GET %s (a read) stays allowed', async (path) => {
    const res = await app.request(path, { headers: auth });
    expect(res.status).toBeLessThan(400);
  });
});

describe.each(['trial', 'pro'])('%s user', (plan) => {
  beforeEach(() => {
    subscription = { ...PLANS[plan] };
  });

  it.each(GUARDED)('%s reaches the handler', async (route) => {
    const res = await send(route);
    expect(res.status).not.toBe(402);
    // Uploads and day notes are app routes (no stub): they answer 200 themselves.
    if (NATIVE.has(route)) expect(res.status).toBe(200);
    else expect(reached).toHaveBeenCalled();
  });
});

describe('after an upgrade', () => {
  it('the same write passes as soon as the stored record is active', async () => {
    subscription = { ...PLANS.expired };
    expect((await send('POST /v1/trades')).status).toBe(402);
    subscription = { ...PLANS.expired, status: 'active', stripeSubscriptionId: 'sub_1' };
    expect((await send('POST /v1/trades')).status).toBe(200);
    expect(reached).toHaveBeenCalledTimes(1);
  });
});

describe('GET /v1/me/entitlements', () => {
  const entitlements = async () => (await (await app.request('/v1/me/entitlements', { headers: auth })).json()).data;

  it('read-only: plan free with every read feature on, no account writable, and when Pro ended', async () => {
    subscription = { ...PLANS.lapsedPro };
    const data = await entitlements();
    expect(data.entitlements).toMatchObject({
      plan: 'free',
      features: { advanced_analytics: true, tax_report: true, unlimited_accounts: true, auto_sync: false },
      proEndedAt: PLANS.lapsedPro.endedAt,
    });
    expect(data.writableAccountIds).toEqual([]);
  });

  it.each(['trial', 'pro'])('%s: every account is writable (null)', async (plan) => {
    subscription = { ...PLANS[plan] };
    expect((await entitlements()).writableAccountIds).toBeNull();
  });
});
