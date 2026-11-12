export const DEFAULT_USER_PREFERENCES = {
  darkMode: false,
  currency: 'USD',
  timezone: 'UTC',
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
