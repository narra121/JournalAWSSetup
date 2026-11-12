import { describe, expect, it } from 'vitest';
import { normalizeCurrency } from '../currency';

describe('normalizeCurrency', () => {
  it('upper-cases and accepts INR and the other supported codes', () => {
    expect(normalizeCurrency('inr')).toBe('INR');
    expect(normalizeCurrency(' usd ')).toBe('USD');
    expect(normalizeCurrency('JPY')).toBe('JPY');
  });

  it('rejects unknown codes and non-strings', () => {
    expect(normalizeCurrency('ABC')).toBeNull();
    expect(normalizeCurrency('')).toBeNull();
    expect(normalizeCurrency(5)).toBeNull();
    expect(normalizeCurrency(undefined)).toBeNull();
  });
});
