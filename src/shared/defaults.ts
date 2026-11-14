/**
 * No `timeZone`: a user has one only once it is saved, so an absent zone means "never chosen" and the app saves the
 * browser's zone on the first signed-in load (TradeFlow usePreferences.ts `useSyncServerPreferences`).
 */
export const DEFAULT_USER_PREFERENCES = {
  darkMode: false,
  currency: 'USD',
  notifications: {
    tradeReminders: true,
    weeklyReport: true,
    goalAlerts: true,
  },
  carryForwardGoalsRules: true,
  weekStart: 'mon',
  defaultPeriod: 'all',
};

export const WEEK_STARTS = ['mon', 'sun'] as const;
export const DEFAULT_PERIODS = ['7d', '30d', '90d', '1y', 'ytd', 'all'] as const;

/** True when `zone` is an IANA time zone name this runtime knows. */
export function isValidTimeZone(zone: unknown): zone is string {
  if (typeof zone !== 'string' || !zone) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}
