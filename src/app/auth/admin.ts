import type { MiddlewareHandler } from 'hono';
import { handler as adminAuthorizer } from '../../handlers/admin-authorizer/app';
import { defaultsFor, errorBody } from '../../shared/apiError';
import type { AppEnv } from '../types';

/** Missing Authorization header → 401, rejected token → 403 (the statuses API Gateway returned for the Lambda authorizer). */
export function requireAdmin(): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const authorization = c.req.header('authorization');
    if (!authorization) return c.json(errorBody('UNAUTHORIZED', defaultsFor(401).message), 401);
    const { isAuthorized } = await adminAuthorizer({ headers: { authorization } });
    if (!isAuthorized) return c.json(errorBody('FORBIDDEN', defaultsFor(403).message), 403);
    await next();
  };
}
