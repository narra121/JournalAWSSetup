import type { MiddlewareHandler } from 'hono';
import { checkRateLimit } from '../../handlers/auth-rate-limit-wrapper/rateLimit';
import { defaultsFor, errorBody } from '../../shared/apiError';
import type { AppEnv } from '../types';

/** One signed-in user, all authenticated routes together. A full 5,000-trade scope load is about 50 requests, so normal use stays far below it. */
export const USER_REQUESTS_PER_WINDOW = 600;
export const USER_WINDOW_SECONDS = 60;

/** The RateLimit-table key of one user's counter (checkRateLimit stores keys trimmed and lower-cased). */
export const userRateLimitKey = (userId: string): string => `user:${userId}`.trim().toLowerCase();

/**
 * Per-user request ceiling so one account cannot use up the endpoint-wide throttle (template.yaml `ThrottleConfig`).
 * Counts in the RateLimit table under `user:<sub>`; answers the shared 429 `RATE_LIMITED` envelope. Needs `requireUser` first.
 * A failing table lets the request through: the limiter must not take the API down.
 */
export function userRateLimit(check: typeof checkRateLimit = checkRateLimit): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    // No table (local server, suites that do not set it): nothing to count against.
    if (!process.env.RATE_LIMIT_TABLE) return next();

    const rl = await check({ key: userRateLimitKey(c.get('userId')), limit: USER_REQUESTS_PER_WINDOW, windowSeconds: USER_WINDOW_SECONDS }).catch((err: Error) => {
      console.warn(JSON.stringify({ msg: 'user_rate_limit_unavailable', error: err?.message }));
      return { allowed: true, retryAfter: undefined };
    });
    if (!rl.allowed) return c.json(errorBody('RATE_LIMITED', defaultsFor(429).message, { retryAfter: rl.retryAfter }), 429);
    return next();
  };
}
