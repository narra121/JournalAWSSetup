const round2 = (v: number) => Math.round((v + Number.EPSILON) * 100) / 100;

/** "₹1,12,500.00", "−$12.50"; a code that Intl does not know is written after the amount. */
export function money(v: number, currency: string | null): string {
  const abs = Math.abs(round2(v));
  // Rupees in lakh grouping, as TradeFlow lib/format.ts localeFor() prints the figures beside these sentences.
  const locale = currency === 'INR' ? 'en-IN' : 'en-US';
  let s: string | null = null;
  if (currency && /^[A-Z]{3}$/.test(currency)) {
    try {
      s = new Intl.NumberFormat(locale, { style: 'currency', currency }).format(abs);
    } catch {
      s = null;
    }
  }
  s ??= `${abs.toLocaleString(locale, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}${currency ? ` ${currency}` : ''}`;
  return `${round2(v) < 0 ? '−' : ''}${s}`;
}

/** "+0.22R", "−1.02R"; with `unsigned`, "8.40R". */
export const rText = (v: number, unsigned = false) => `${unsigned ? '' : v >= 0 ? '+' : '−'}${Math.abs(v).toFixed(2)}R`;

export const pct = (share: number) => `${(share * 100).toFixed(1).replace(/\.0$/, '')}%`;

export const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

const ORDINALS = ['first', 'second', 'third', 'fourth', 'fifth', 'sixth', 'seventh', 'eighth', 'ninth', 'tenth', 'eleventh', 'twelfth', 'thirteenth'];
export const ordinalWord = (n: number) => ORDINALS[n - 1] ?? `${n}th`;
