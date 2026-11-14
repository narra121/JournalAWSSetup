import { describe, it, expect } from 'vitest';
import { DEFAULT_USER_PREFERENCES } from '../defaults.js';

// ─── DEFAULT_USER_PREFERENCES ──────────────────────────────────

describe('DEFAULT_USER_PREFERENCES', () => {
  it('has expected top-level properties', () => {
    expect(DEFAULT_USER_PREFERENCES).toHaveProperty('darkMode');
    expect(DEFAULT_USER_PREFERENCES).toHaveProperty('currency');
    expect(DEFAULT_USER_PREFERENCES).toHaveProperty('notifications');
    expect(DEFAULT_USER_PREFERENCES).toHaveProperty('carryForwardGoalsRules');
  });

  it('defaults darkMode to false', () => {
    expect(DEFAULT_USER_PREFERENCES.darkMode).toBe(false);
  });

  it('defaults currency to USD', () => {
    expect(DEFAULT_USER_PREFERENCES.currency).toBe('USD');
  });

  it('has no time zone: an absent timeZone means the user never chose one (the app then saves the browser zone)', () => {
    expect(DEFAULT_USER_PREFERENCES).not.toHaveProperty('timeZone');
    expect(DEFAULT_USER_PREFERENCES).not.toHaveProperty('timezone');
  });

  it('defaults carryForwardGoalsRules to true', () => {
    expect(DEFAULT_USER_PREFERENCES.carryForwardGoalsRules).toBe(true);
  });

  it('has all notification preferences defaulted to true', () => {
    const { notifications } = DEFAULT_USER_PREFERENCES;
    expect(notifications.tradeReminders).toBe(true);
    expect(notifications.weeklyReport).toBe(true);
    expect(notifications.goalAlerts).toBe(true);
  });
});
