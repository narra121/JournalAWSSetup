import { describe, it, expect } from 'vitest';
import { validatePassword, PASSWORD_MIN, PASSWORD_MAX } from '../passwordValidation.js';

// ─── Constants ─────────────────────────────────────────────────

describe('PASSWORD_MIN / PASSWORD_MAX', () => {
  it('has expected minimum and maximum values', () => {
    expect(PASSWORD_MIN).toBe(8);
    expect(PASSWORD_MAX).toBe(128);
  });
});

// ─── validatePassword ──────────────────────────────────────────

describe('validatePassword', () => {
  it('returns null for a valid password', () => {
    expect(validatePassword('MyP@ssw0rd')).toBeNull();
  });

  it('returns null for password at exactly minimum length', () => {
    const password = 'a'.repeat(PASSWORD_MIN);
    expect(validatePassword(password)).toBeNull();
  });

  it('returns null for password at exactly maximum length', () => {
    const password = 'a'.repeat(PASSWORD_MAX);
    expect(validatePassword(password)).toBeNull();
  });

  it('returns error for password shorter than minimum', () => {
    const password = 'a'.repeat(PASSWORD_MIN - 1);
    const result = validatePassword(password);
    expect(result).not.toBeNull();
    expect(result).toContain(`${PASSWORD_MIN}`);
    expect(result).toContain(`${PASSWORD_MAX}`);
  });

  it('returns error for password longer than maximum', () => {
    const password = 'a'.repeat(PASSWORD_MAX + 1);
    const result = validatePassword(password);
    expect(result).not.toBeNull();
    expect(result).toContain(`${PASSWORD_MIN}`);
    expect(result).toContain(`${PASSWORD_MAX}`);
  });

  it('returns error for empty string', () => {
    expect(validatePassword('')).not.toBeNull();
  });

  it('returns error for null/undefined coerced as empty', () => {
    // The function checks !password first, so falsy values trigger error
    expect(validatePassword(null as any)).not.toBeNull();
    expect(validatePassword(undefined as any)).not.toBeNull();
  });

  it('returns error for single character password', () => {
    expect(validatePassword('x')).not.toBeNull();
  });

  it('returns null for password with special characters', () => {
    expect(validatePassword('p@$$w0rd!')).toBeNull();
  });

  it('returns null for password with unicode characters', () => {
    const password = '\u{1F600}'.repeat(4); // 4 emoji = 8 chars (but .length may vary)
    // Each emoji is 2 code units, so .length = 8 which meets PASSWORD_MIN
    if (password.length >= PASSWORD_MIN) {
      expect(validatePassword(password)).toBeNull();
    }
  });

  it('returns error message with correct min/max values', () => {
    const result = validatePassword('short');
    expect(result).toBe(`Password must be ${PASSWORD_MIN}-${PASSWORD_MAX} characters`);
  });
});
