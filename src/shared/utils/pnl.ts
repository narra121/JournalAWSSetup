/**
 * Calculate PnL for a trade record.
 * Uses stored pnl field if available, otherwise calculates from prices (times `contractMultiplier`, default 1, like
 * the client and the R multiple). Undefined when an input is missing or the side is not BUY/SELL.
 */
export function calcPnL(item: any): number | undefined {
  if (item.pnl != null && typeof item.pnl === 'number') return item.pnl;
  const entry = item.entryPrice;
  const exit = item.exitPrice;
  const qty = item.quantity;
  const side = item.side;
  if (entry == null || exit == null || qty == null || side == null) return undefined;
  const multiplier = Number(item.contractMultiplier) > 0 ? Number(item.contractMultiplier) : 1;
  if (side === 'BUY') return (exit - entry) * qty * multiplier;
  if (side === 'SELL') return (entry - exit) * qty * multiplier;
  return undefined;
}

/**
 * Extract YYYY-MM-DD from an openDate that may be date-only or full ISO.
 * Handles: "2026-04-10", "2026-04-10T14:30:00Z", "2026-04-10T14:30:00.000Z"
 */
export function extractDate(openDate: string): string {
  if (!openDate) return '';
  return openDate.split('T')[0];
}
