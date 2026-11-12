import type { MiddlewareHandler } from 'hono';
import { handler as adminAuthorizer } from '../../handlers/admin-authorizer/app';
import type { AppEnv } from '../types';

/** Missing Authorization header → 401, rejected token → 403 (the statuses API Gateway returned for the Lambda authorizer). */
export function requireAdmin(): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const authorization = c.req.header('authorization');
    if (!authorization) return c.json({ message: 'Unauthorized' }, 401);
    const { isAuthorized } = await adminAuthorizer({ headers: { authorization } });
    if (!isAuthorized) return c.json({ message: 'Forbidden' }, 403);
    await next();
  };
}
