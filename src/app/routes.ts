import type { MiddlewareHandler } from 'hono';
import { handler as adminDeleteUser } from '../handlers/admin-delete-user/app';
import { handler as adminGetConfig } from '../handlers/admin-get-config/app';
import { handler as adminGetUser } from '../handlers/admin-get-user/app';
import { handler as adminGetUserStats } from '../handlers/admin-get-user-stats/app';
import { handler as adminListUserTrades } from '../handlers/admin-list-user-trades/app';
import { handler as adminListUsers } from '../handlers/admin-list-users/app';
import { handler as adminLogin } from '../handlers/admin-login/app';
import { handler as adminManageSubscription } from '../handlers/admin-manage-subscription/app';
import { handler as adminUpdateConfig } from '../handlers/admin-update-config/app';
import { handler as adminUpdateUser } from '../handlers/admin-update-user/app';
import { handler as authConfirmForgotPassword } from '../handlers/auth-confirm-forgot-password/app';
import { handler as authConfirmSignup } from '../handlers/auth-confirm-signup/app';
import { handler as authForgotPassword } from '../handlers/auth-forgot-password/app';
import { handler as authLogin } from '../handlers/auth-login/app';
import { handler as authRefresh } from '../handlers/auth-refresh/app';
import { handler as authSignup } from '../handlers/auth-signup/app';
import { handler as bulkDeleteTrades } from '../handlers/bulk-delete-trades/app';
import { handler as bulkUpdateTrades } from '../handlers/bulk-update-trades/app';
import { handler as createAccount } from '../handlers/create-account/app';
import { handler as createGoal } from '../handlers/create-goal/app';
import { handler as createRule } from '../handlers/create-rule/app';
import { handler as createStripeCheckout } from '../handlers/create-stripe-checkout/app';
import { handler as createTrade } from '../handlers/create-trade/app';
import { handler as deleteAccount } from '../handlers/delete-account/app';
import { handler as deleteRule } from '../handlers/delete-rule/app';
import { handler as deleteTrade } from '../handlers/delete-trade/app';
import { handler as enhanceText } from '../handlers/enhance-text/app';
import { handler as extractTrades } from '../handlers/extract-trades/app';
import { handler as getAdConfig } from '../handlers/get-ad-config/app';
import { handler as getTrade } from '../handlers/get-trade/app';
import { handler as getGoalsProgress } from '../handlers/get-goals-progress/app';
import { handler as getImage } from '../handlers/get-image/app';
import { handler as getRulesGoals } from '../handlers/get-rules-goals/app';
import { handler as getSavedOptions } from '../handlers/get-saved-options/app';
import { handler as getStats } from '../handlers/get-stats/app';
import { handler as getSubscriptionPlans } from '../handlers/get-subscription-plans/app';
import { handler as getUserProfile } from '../handlers/get-user-profile/app';
import { handler as listAccounts } from '../handlers/list-accounts/app';
import { handler as listRules } from '../handlers/list-rules/app';
import { handler as listTrades } from '../handlers/list-trades/app';
import { handler as manageStripeSubscription } from '../handlers/manage-stripe-subscription/app';
import { handler as reportError } from '../handlers/report-error/app';
import { handler as stripeWebhook } from '../handlers/stripe-webhook/app';
import { handler as restoreTrades } from '../handlers/restore-trades/app';
import { handler as syncTrades } from '../handlers/sync-trades/app';
import { handler as updateAccount } from '../handlers/update-account/app';
import { handler as updateAccountStatus } from '../handlers/update-account-status/app';
import { handler as updateGoal } from '../handlers/update-goal/app';
import { handler as updateRule } from '../handlers/update-rule/app';
import { handler as updateSavedOptions } from '../handlers/update-saved-options/app';
import { handler as updateTrade } from '../handlers/update-trade/app';
import { handler as updateUserNotifications } from '../handlers/update-user-notifications/app';
import { handler as updateUserPreferences } from '../handlers/update-user-preferences/app';
import { handler as updateUserProfile } from '../handlers/update-user-profile/app';
import { handler as verifyCheckoutSession } from '../handlers/verify-checkout-session/app';
import { optionalUser } from './auth/cognito';
import { advancedAnalyticsGate, metered } from './billing/middleware';
import { extractUnits } from './billing/extractUnits';
import type { LegacyHandler } from './http/adapter';
import type { AppEnv } from './types';

export type AuthGroup = 'cognito' | 'admin' | 'public';

export interface RouteDef {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  /** API Gateway notation: `{x}` is a path parameter, `{x+}` a greedy one. */
  path: string;
  auth: AuthGroup;
  handler: LegacyHandler;
  /** Runs after authentication and before the handler. */
  extra?: MiddlewareHandler<AppEnv>[];
}

const r = (
  method: RouteDef['method'],
  path: string,
  auth: AuthGroup,
  handler: LegacyHandler,
  extra?: MiddlewareHandler<AppEnv>[],
): RouteDef => ({ method, path, auth, handler, extra });

/** Every HTTP route of the original API Gateway template. */
export const LEGACY_ROUTES: RouteDef[] = [
  r('GET', '/v1/accounts', 'cognito', listAccounts),
  r('POST', '/v1/accounts', 'cognito', createAccount),
  r('DELETE', '/v1/accounts/{accountId}', 'cognito', deleteAccount),
  r('PUT', '/v1/accounts/{accountId}', 'cognito', updateAccount),
  r('PATCH', '/v1/accounts/{accountId}/status', 'cognito', updateAccountStatus),
  r('GET', '/v1/ad-config', 'cognito', getAdConfig),
  r('GET', '/v1/admin/config', 'admin', adminGetConfig),
  r('PUT', '/v1/admin/config', 'admin', adminUpdateConfig),
  r('POST', '/v1/admin/login', 'public', adminLogin),
  r('GET', '/v1/admin/users', 'admin', adminListUsers),
  r('DELETE', '/v1/admin/users/{userId}', 'admin', adminDeleteUser),
  r('GET', '/v1/admin/users/{userId}', 'admin', adminGetUser),
  r('PUT', '/v1/admin/users/{userId}', 'admin', adminUpdateUser),
  r('GET', '/v1/admin/users/{userId}/stats', 'admin', adminGetUserStats),
  r('PUT', '/v1/admin/users/{userId}/subscription', 'admin', adminManageSubscription),
  r('GET', '/v1/admin/users/{userId}/trades', 'admin', adminListUserTrades),
  r('POST', '/v1/auth/confirm-forgot-password', 'public', authConfirmForgotPassword),
  r('POST', '/v1/auth/confirm-signup', 'public', authConfirmSignup),
  r('POST', '/v1/auth/forgot-password', 'public', authForgotPassword),
  r('POST', '/v1/auth/login', 'public', authLogin),
  r('POST', '/v1/auth/refresh', 'public', authRefresh),
  r('POST', '/v1/auth/signup', 'public', authSignup),
  r('POST', '/v1/enhance-text', 'cognito', enhanceText, [metered('ai_enhance')]),
  r('POST', '/v1/errors/report', 'public', reportError, [optionalUser()]),
  r('POST', '/v1/goals', 'cognito', createGoal),
  r('GET', '/v1/goals/progress', 'cognito', getGoalsProgress),
  r('PUT', '/v1/goals/{goalId}', 'cognito', updateGoal),
  r('GET', '/v1/images/{imageId+}', 'cognito', getImage),
  r('GET', '/v1/options', 'cognito', getSavedOptions),
  r('PUT', '/v1/options', 'cognito', updateSavedOptions),
  r('POST', '/v1/payments/webhook', 'public', stripeWebhook),
  r('GET', '/v1/rules', 'cognito', listRules),
  r('POST', '/v1/rules', 'cognito', createRule),
  r('GET', '/v1/rules-goals', 'cognito', getRulesGoals),
  r('DELETE', '/v1/rules/{ruleId}', 'cognito', deleteRule),
  r('PUT', '/v1/rules/{ruleId}', 'cognito', updateRule),
  r('GET', '/v1/stats', 'cognito', getStats, [advancedAnalyticsGate()]),
  r('DELETE', '/v1/subscriptions', 'cognito', manageStripeSubscription),
  r('GET', '/v1/subscriptions', 'cognito', manageStripeSubscription),
  r('PATCH', '/v1/subscriptions', 'cognito', manageStripeSubscription),
  r('POST', '/v1/subscriptions', 'cognito', createStripeCheckout),
  r('PUT', '/v1/subscriptions', 'cognito', manageStripeSubscription),
  r('GET', '/v1/subscriptions/plans', 'public', getSubscriptionPlans),
  r('GET', '/v1/subscriptions/verify', 'cognito', verifyCheckoutSession),
  r('GET', '/v1/trades', 'cognito', listTrades),
  r('POST', '/v1/trades', 'cognito', createTrade),
  r('POST', '/v1/trades/bulk-delete', 'cognito', bulkDeleteTrades),
  r('POST', '/v1/trades/bulk-update', 'cognito', bulkUpdateTrades),
  r('POST', '/v1/trades/extract', 'cognito', extractTrades, [metered('ai_extract', async (c) => extractUnits(await c.req.raw.clone().text()))]),
  r('POST', '/v1/trades/restore', 'cognito', restoreTrades),
  r('POST', '/v1/trades/sync', 'cognito', syncTrades),
  r('GET', '/v1/trades/{tradeId}', 'cognito', getTrade),
  r('DELETE', '/v1/trades/{tradeId}', 'cognito', deleteTrade),
  r('PUT', '/v1/trades/{tradeId}', 'cognito', updateTrade),
  r('PUT', '/v1/user/notifications', 'cognito', updateUserNotifications),
  r('PUT', '/v1/user/preferences', 'cognito', updateUserPreferences),
  r('GET', '/v1/user/profile', 'cognito', getUserProfile),
  r('PUT', '/v1/user/profile', 'cognito', updateUserProfile),
];

/** `/v1/images/{imageId+}` → `/v1/images/:imageId{.+}`, `/v1/trades/{id}` → `/v1/trades/:id`. */
export function toHonoPath(apiGatewayPath: string): string {
  return apiGatewayPath.replace(/\{(\w+)\+\}/g, ':$1{.+}').replace(/\{(\w+)\}/g, ':$1');
}
