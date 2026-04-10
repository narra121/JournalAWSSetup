import { calcPnL, extractDate } from '../../utils/pnl';

describe('calcPnL', () => {
  it('returns stored pnl when available', () => {
    const trade = { pnl: 150 };
    expect(calcPnL(trade)).toBe(150);
  });

  it('returns stored pnl of 0 (should NOT fallback)', () => {
    const trade = { pnl: 0, entryPrice: 100, exitPrice: 110, quantity: 1, side: 'BUY' };
    expect(calcPnL(trade)).toBe(0);
  });

  it('returns stored negative pnl', () => {
    const trade = { pnl: -50 };
    expect(calcPnL(trade)).toBe(-50);
  });

  it('calculates BUY pnl from prices: (exit - entry) * qty', () => {
    const trade = { entryPrice: 100, exitPrice: 110, quantity: 2, side: 'BUY' };
    expect(calcPnL(trade)).toBe(20);
  });

  it('calculates SELL pnl from prices: (entry - exit) * qty', () => {
    const trade = { entryPrice: 110, exitPrice: 100, quantity: 2, side: 'SELL' };
    expect(calcPnL(trade)).toBe(20);
  });

  it('returns undefined when entry/exit/qty/side missing', () => {
    expect(calcPnL({ entryPrice: 100 })).toBeUndefined();
    expect(calcPnL({ exitPrice: 100 })).toBeUndefined();
    expect(calcPnL({ entryPrice: 100, exitPrice: 110 })).toBeUndefined();
    expect(calcPnL({ entryPrice: 100, exitPrice: 110, quantity: 1 })).toBeUndefined();
    expect(calcPnL({})).toBeUndefined();
  });

  it('returns undefined for unknown side', () => {
    const trade = { entryPrice: 100, exitPrice: 110, quantity: 1, side: 'HOLD' };
    expect(calcPnL(trade)).toBeUndefined();
  });

  it('prefers stored pnl over calculated', () => {
    const trade = { pnl: 150, entryPrice: 100, exitPrice: 110, quantity: 1, side: 'BUY' };
    // Calculated would be 10, but stored 150 wins
    expect(calcPnL(trade)).toBe(150);
  });
});

describe('extractDate', () => {
  it('extracts date from ISO string', () => {
    expect(extractDate('2026-04-10T14:30:00Z')).toBe('2026-04-10');
  });

  it('returns date-only string as-is', () => {
    expect(extractDate('2026-04-10')).toBe('2026-04-10');
  });

  it('handles ISO with milliseconds', () => {
    expect(extractDate('2026-04-10T14:30:00.000Z')).toBe('2026-04-10');
  });

  it('returns empty string for empty input', () => {
    expect(extractDate('')).toBe('');
  });

  it('returns empty string for falsy input', () => {
    expect(extractDate(undefined as any)).toBe('');
    expect(extractDate(null as any)).toBe('');
  });
});
