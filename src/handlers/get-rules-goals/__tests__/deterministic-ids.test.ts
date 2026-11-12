import { describe, expect, it, vi } from 'vitest';

vi.stubEnv('RULES_TABLE', 'rules');
vi.stubEnv('GOALS_TABLE', 'goals');
vi.stubEnv('USER_PREFERENCES_TABLE', 'prefs');

const { createDefaultRules, createDefaultGoals } = await import('../app');

describe('period records have derived ids (two concurrent first reads write the same keys, B-066)', () => {
  it('default rules and goals get the same ids on every call', () => {
    const ids = (items: any[], key: string) => items.map((i) => i[key]);
    expect(ids(createDefaultRules('u', 'week#2026-11-09'), 'ruleId')).toEqual(ids(createDefaultRules('u', 'week#2026-11-09'), 'ruleId'));
    expect(ids(createDefaultGoals('u', 'month#2026-11'), 'goalId')).toEqual(ids(createDefaultGoals('u', 'month#2026-11'), 'goalId'));
  });

  it('ids are scoped by period key and distinct within a period', () => {
    const a = createDefaultRules('u', 'week#2026-11-09').map((r) => r.ruleId);
    const b = createDefaultRules('u', 'week#2026-11-16').map((r) => r.ruleId);
    expect(new Set(a).size).toBe(a.length);
    expect(a.every((id) => id.startsWith('week#2026-11-09#'))).toBe(true);
    expect(a.some((id) => b.includes(id))).toBe(false);
  });
});
