import { GetCommand } from '@aws-sdk/lib-dynamodb';
import type { MiddlewareHandler } from 'hono';
import { ddb } from '../../shared/dynamo';
import type { AppEnv, QuotaFeature } from '../types';
import { computeEntitlements } from './entitlements';
import { createQuota } from './quota';
import { planRequired, quotaExceeded } from './responses';

/** Loads the caller's Subscriptions item once and exposes `entitlements`, `quota` and `subscription`. Needs `requireUser` first. */
export function withEntitlements(): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const userId = c.get('userId');
    const res = await ddb.send(new GetCommand({ TableName: process.env.SUBSCRIPTIONS_TABLE!, Key: { userId } }));
    const subscription = res.Item as Record<string, any> | undefined;
    const entitlements = computeEntitlements(subscription);
    c.set('subscription', subscription);
    c.set('entitlements', entitlements);
    c.set('quota', createQuota(userId, entitlements));
    await next();
  };
}

/** Consumes one unit before the handler and refunds it when the handler answers with status >= 400. */
export function metered(feature: QuotaFeature): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const taken = await c.get('quota').consume(feature);
    if (!taken.ok) return quotaExceeded(c, feature, c.get('entitlements'), taken.resetsAt);
    await next();
    if (c.res.status >= 400) await c.get('quota').consume(feature, -1);
  };
}

/** `GET /stats?sections=advanced` needs the advanced-analytics feature; the default response is open to every plan. */
export function advancedAnalyticsGate(): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    if ((c.req.query('sections') ?? '').split(',').includes('advanced')) {
      await withEntitlements()(c, async () => undefined);
      const entitlements = c.get('entitlements');
      if (!entitlements.features.advanced_analytics) return planRequired(c, 'advanced_analytics', entitlements);
    }
    await next();
  };
}
