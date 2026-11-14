import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import { GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import type { Context, MiddlewareHandler } from 'hono';
import { errorBody } from '../../shared/apiError';
import { ddb } from '../../shared/dynamo';
import { wantsAdvancedSection } from '../../shared/statsSections';
import type { AppEnv, QuotaFeature } from '../types';
import { computeEntitlements, effectiveSubscription, isReadOnly, PLANS_VERSION } from './entitlements';
import { createQuota } from './quota';
import { planRequired, quotaExceeded } from './responses';

const table = () => process.env.SUBSCRIPTIONS_TABLE!;

async function readSubscription(userId: string): Promise<Record<string, any> | undefined> {
  return (await ddb.send(new GetCommand({ TableName: table(), Key: { userId } }))).Item as Record<string, any> | undefined;
}

/**
 * Puts a record from before the trial and Pro plans on them once (`effectiveSubscription`). Only the marker, the trial
 * end and a missing status or createdAt are written, so a webhook writing `status` at the same time is never undone.
 */
async function ensurePlansVersion(userId: string, stored: Record<string, any> | undefined): Promise<Record<string, any>> {
  const now = new Date();
  const next = effectiveSubscription(stored, now);
  const at = now.toISOString();
  const trial = next.trialEnd !== stored?.trialEnd;
  try {
    await ddb.send(
      new UpdateCommand({
        TableName: table(),
        Key: { userId },
        UpdateExpression: trial
          ? 'SET plansVersion = :v, trialEnd = :end, trialGrantedAt = :now, #s = if_not_exists(#s, :trial), createdAt = if_not_exists(createdAt, :now), updatedAt = :now'
          : 'SET plansVersion = :v',
        ConditionExpression: 'attribute_not_exists(plansVersion)',
        ExpressionAttributeNames: trial ? { '#s': 'status' } : undefined,
        ExpressionAttributeValues: trial ? { ':v': PLANS_VERSION, ':end': next.trialEnd, ':now': at, ':trial': 'trial' } : { ':v': PLANS_VERSION },
      }),
    );
  } catch (err) {
    if (!(err instanceof ConditionalCheckFailedException || (err as any)?.name === 'ConditionalCheckFailedException')) throw err;
    // Another request migrated the record first.
    return (await readSubscription(userId)) ?? next;
  }
  return { userId, ...next, ...(trial ? { trialGrantedAt: at } : {}) };
}

/** Loads the caller's Subscriptions item once and exposes `entitlements`, `quota` and `subscription`. Needs `requireUser` first. */
export function withEntitlements(): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    if (c.get('entitlements')) return next();
    const userId = c.get('userId');
    let subscription = await readSubscription(userId);
    if (subscription?.plansVersion !== PLANS_VERSION) subscription = await ensurePlansVersion(userId, subscription);
    const entitlements = computeEntitlements(subscription);
    c.set('subscription', subscription);
    c.set('entitlements', entitlements);
    c.set('quota', createQuota(userId, entitlements));
    await next();
  };
}

export const TRIAL_EXPIRED_MESSAGE = 'Your free trial has ended. Upgrade to Pro to add, edit or delete.';

export const trialExpiredBody = () => errorBody('TRIAL_EXPIRED', TRIAL_EXPIRED_MESSAGE);

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Writes a read-only user may still make: sign-out everywhere, billing, deleting the user account, the e-mail switches
 * (unsubscribe), and the analysis questions that are sent as POST but store nothing.
 */
const EXEMPT_WRITES: [method: string, path: RegExp][] = [
  ['POST', /^\/v1\/auth\/logout-all$/],
  ['DELETE', /^\/v1\/auth\/account$/],
  ['*', /^\/v1\/billing\//],
  ['*', /^\/v1\/subscriptions(\/|$)/],
  ['PUT', /^\/v1\/user\/notifications$/],
  ['POST', /^\/v1\/analysis\/(what-if|query)$/],
];

export function isExemptWrite(method: string, path: string): boolean {
  return EXEMPT_WRITES.some(([m, re]) => (m === '*' || m === method) && re.test(path));
}

/**
 * After the trial (or a lapsed Pro) every signed-in write answers 402 TRIAL_EXPIRED unless it is exempt; every read
 * passes. Runs on every signed-in route of the app (src/app/app.ts `signedIn`), after `withEntitlements`.
 */
export function readOnlyGuard(): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const method = c.req.method.toUpperCase();
    if (SAFE_METHODS.has(method) || !isReadOnly(c.get('entitlements')) || isExemptWrite(method, c.req.path)) return next();
    return c.json(trialExpiredBody(), 402);
  };
}

/** Consumes `units(c)` units (default 1) before the handler and refunds them when the handler answers with status >= 400. */
export function metered(feature: QuotaFeature, units?: (c: Context<AppEnv>) => Promise<number>): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const n = units ? await units(c) : 1;
    const taken = await c.get('quota').consume(feature, n);
    if (!taken.ok) return quotaExceeded(c, feature, c.get('entitlements'), taken.resetsAt);
    await next();
    if (c.res.status >= 400) await c.get('quota').consume(feature, -n);
  };
}

/** `GET /stats?sections=advanced` needs the advanced-analytics feature; the default response is open to every plan. */
export function advancedAnalyticsGate(): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    if (wantsAdvancedSection(c.req.queries('sections')?.join(','))) {
      await withEntitlements()(c, async () => undefined);
      const entitlements = c.get('entitlements');
      if (!entitlements.features.advanced_analytics) return planRequired(c, 'advanced_analytics', entitlements);
    }
    await next();
  };
}
