/** ISO-4217 codes accepted for trading accounts. */
export const ACCOUNT_CURRENCIES = [
  'USD', 'EUR', 'GBP', 'INR', 'JPY', 'AUD', 'CAD', 'CHF', 'SGD', 'AED', 'HKD', 'NZD', 'ZAR', 'CNY', 'SEK', 'NOK',
  'DKK', 'MXN', 'BRL', 'KRW', 'TRY', 'THB', 'MYR', 'IDR', 'PHP', 'SAR', 'PLN', 'CZK',
] as const;

/** Upper-cased currency code, or null when it is not an accepted code. */
export function normalizeCurrency(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const code = value.trim().toUpperCase();
  return (ACCOUNT_CURRENCIES as readonly string[]).includes(code) ? code : null;
}
