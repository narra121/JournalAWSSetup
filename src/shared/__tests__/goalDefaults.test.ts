import { describe, it, expect } from 'vitest';
import {
  VALID_GOAL_TYPES,
  VALID_PERIODS,
  GOAL_TYPE_CONFIG,
  DEFAULT_GOAL_TARGETS,
} from '../goalDefaults.js';

// ─── VALID_GOAL_TYPES ──────────────────────────────────────────

describe('VALID_GOAL_TYPES', () => {
  it('contains expected goal types', () => {
    expect(VALID_GOAL_TYPES).toEqual(['profit', 'winRate', 'maxDrawdown', 'maxTrades']);
  });

  it('is a readonly tuple', () => {
    // Readonly tuples have a length property but cannot be mutated at runtime
    expect(VALID_GOAL_TYPES).toHaveLength(4);
  });
});

// ─── VALID_PERIODS ─────────────────────────────────────────────

describe('VALID_PERIODS', () => {
  it('contains expected periods', () => {
    expect(VALID_PERIODS).toEqual(['weekly', 'monthly']);
  });
});

// ─── GOAL_TYPE_CONFIG ──────────────────────────────────────────

describe('GOAL_TYPE_CONFIG', () => {
  it('has a config entry for every valid goal type', () => {
    for (const goalType of VALID_GOAL_TYPES) {
      expect(GOAL_TYPE_CONFIG).toHaveProperty(goalType);
    }
  });

  it('each config has required fields', () => {
    for (const goalType of VALID_GOAL_TYPES) {
      const config = GOAL_TYPE_CONFIG[goalType];
      expect(typeof config.title).toBe('string');
      expect(config.title.length).toBeGreaterThan(0);
      expect(typeof config.description).toBe('string');
      expect(config.description.length).toBeGreaterThan(0);
      expect(typeof config.unit).toBe('string');
      expect(typeof config.icon).toBe('string');
      expect(typeof config.color).toBe('string');
      expect(typeof config.isInverse).toBe('boolean');
    }
  });

  it('marks maxDrawdown and maxTrades as inverse goals', () => {
    expect(GOAL_TYPE_CONFIG.maxDrawdown.isInverse).toBe(true);
    expect(GOAL_TYPE_CONFIG.maxTrades.isInverse).toBe(true);
  });

  it('marks profit and winRate as non-inverse goals', () => {
    expect(GOAL_TYPE_CONFIG.profit.isInverse).toBe(false);
    expect(GOAL_TYPE_CONFIG.winRate.isInverse).toBe(false);
  });

  it('has correct units for each goal type', () => {
    expect(GOAL_TYPE_CONFIG.profit.unit).toBe('$');
    expect(GOAL_TYPE_CONFIG.winRate.unit).toBe('%');
    expect(GOAL_TYPE_CONFIG.maxDrawdown.unit).toBe('%');
    expect(GOAL_TYPE_CONFIG.maxTrades.unit).toContain('trades');
  });
});

// ─── DEFAULT_GOAL_TARGETS ──────────────────────────────────────

describe('DEFAULT_GOAL_TARGETS', () => {
  it('has targets for every valid period', () => {
    for (const period of VALID_PERIODS) {
      expect(DEFAULT_GOAL_TARGETS).toHaveProperty(period);
    }
  });

  it('has targets for every goal type within each period', () => {
    for (const period of VALID_PERIODS) {
      for (const goalType of VALID_GOAL_TYPES) {
        expect(DEFAULT_GOAL_TARGETS[period]).toHaveProperty(goalType);
        expect(typeof DEFAULT_GOAL_TARGETS[period][goalType]).toBe('number');
      }
    }
  });

  it('monthly targets are greater than or equal to weekly targets', () => {
    for (const goalType of VALID_GOAL_TYPES) {
      expect(DEFAULT_GOAL_TARGETS.monthly[goalType]).toBeGreaterThanOrEqual(
        DEFAULT_GOAL_TARGETS.weekly[goalType],
      );
    }
  });

  it('all target values are positive numbers', () => {
    for (const period of VALID_PERIODS) {
      for (const goalType of VALID_GOAL_TYPES) {
        expect(DEFAULT_GOAL_TARGETS[period][goalType]).toBeGreaterThan(0);
      }
    }
  });
});
