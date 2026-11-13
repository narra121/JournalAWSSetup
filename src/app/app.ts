import { Hono, type Handler, type MiddlewareHandler } from 'hono';
import { requireAdmin } from './auth/admin';
import { requireUser } from './auth/cognito';
import { goalsHistoryRoutes } from './goals/history';
import { uploadRoutes } from './uploads/routes';
import { journalRoutes } from './journal/routes';
import { accountRoutes } from './account/routes';
import { withEntitlements } from './billing/middleware';
import { billingRoutes, meRoutes } from './billing/routes';
import { apiGatewayCors } from './http/cors';
import { lambdaRoute } from './http/adapter';
import { errorContract, notFound, onError } from './http/errors';
import { requestLog } from './http/log';
import { userRateLimit } from './http/rate-limit';
import { LEGACY_ROUTES, toHonoPath } from './routes';
import type { AppEnv } from './types';

export interface FeatureRoute {
  basePath: string;
  app: Hono<AppEnv>;
}

export interface AppOptions {
  featureRoutes?: FeatureRoute[];
}

/** Every signed-in route: the Cognito token first, then the per-user request ceiling. */
const signedIn = (): MiddlewareHandler<AppEnv>[] => [requireUser(), userRateLimit()];

/** Middleware order: request log → CORS → error contract → per-route auth + per-user rate limit → entitlements/quota → handler; unknown routes and errors use the envelope. */
export function createApp({ featureRoutes = [] }: AppOptions = {}): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.use('*', requestLog());
  app.use('*', apiGatewayCors());
  app.use('*', errorContract());

  for (const route of LEGACY_ROUTES) {
    const auth = route.auth === 'cognito' ? signedIn() : route.auth === 'admin' ? [requireAdmin()] : [];
    const chain: Handler<AppEnv>[] = [
      ...auth,
      ...(route.extra ?? []),
      lambdaRoute(route.handler, `${route.method} ${route.path}`),
    ];
    app.on(route.method, toHonoPath(route.path), ...(chain as [Handler<AppEnv>]));
  }

  for (const path of ['/v1/auth/export', '/v1/auth/account', '/v1/auth/logout-all']) app.use(path, ...signedIn());
  app.route('/v1', accountRoutes);

  app.use('/v1/goals/history', ...signedIn());
  app.route('/v1/goals', goalsHistoryRoutes);

  app.use('/v1/uploads/*', ...signedIn());
  app.route('/v1/uploads', uploadRoutes);

  app.use('/v1/journal/*', ...signedIn());
  app.route('/v1/journal', journalRoutes);

  app.use('/v1/me/*', ...signedIn(), withEntitlements());
  app.route('/v1', meRoutes);
  app.use('/v1/billing/*', ...signedIn(), withEntitlements());
  app.route('/v1', billingRoutes);

  for (const { basePath, app: feature } of featureRoutes) {
    app.use(`/v1${basePath}/*`, ...signedIn(), withEntitlements());
    app.route(`/v1${basePath}`, feature);
  }

  app.notFound(notFound);
  app.onError(onError);
  return app;
}
