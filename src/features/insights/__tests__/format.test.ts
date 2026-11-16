import { describe, expect, it } from 'vitest';
import { money } from '../format';

describe('money', () => {
  it('groups rupees in lakhs and crores, as the app prints the figures beside the sentences (dev: "₹112,500.00" beside "₹1,12,500.00")', () => {
    expect(money(112500, 'INR')).toBe('₹1,12,500.00');
    expect(money(-10000000, 'INR')).toBe('−₹1,00,00,000.00');
    expect(money(-112500, 'USD')).toBe('−$112,500.00');
    expect(money(1234.5, 'XYZ')).toBe('XYZ 1,234.50');
    expect(money(1234.5, null)).toBe('1,234.50');
  });
});
