import { MetricProcessor, AggregationProcessor, TradeRecord, ProcessorContext, AggregationContext } from '../types';
import { calcPnL } from '../../utils/pnl';

/**
 * Core stats: tradeCount, wins, losses, breakeven, grossProfit, grossLoss, totalPnl, totalVolume
 * Aggregation strategy: SUM
 */
export class CoreStatsProcessor implements MetricProcessor {
  readonly name = 'coreStats';
  private tradeCount = 0;
  private wins = 0;
  private losses = 0;
  private breakeven = 0;
  private grossProfit = 0;
  private grossLoss = 0;
  private totalVolume = 0;

  processTrade(trade: TradeRecord): void {
    const pnl = calcPnL(trade) ?? 0;
    this.tradeCount++;
    if (pnl > 0) { this.wins++; this.grossProfit += pnl; }
    else if (pnl < 0) { this.losses++; this.grossLoss += Math.abs(pnl); }
    else { this.breakeven++; }
    this.totalVolume += trade.quantity || 0;
  }

  getResult() {
    return {
      tradeCount: this.tradeCount,
      wins: this.wins,
      losses: this.losses,
      breakeven: this.breakeven,
      grossProfit: this.grossProfit,
      grossLoss: this.grossLoss,
      totalPnl: this.grossProfit - this.grossLoss,
      totalVolume: this.totalVolume,
    };
  }

  reset(): void {
    this.tradeCount = 0;
    this.wins = 0;
    this.losses = 0;
    this.breakeven = 0;
    this.grossProfit = 0;
    this.grossLoss = 0;
    this.totalVolume = 0;
  }
}

export class CoreStatsAggregator implements AggregationProcessor {
  readonly name = 'coreStats';
  private totalTrades = 0;
  private wins = 0;
  private losses = 0;
  private breakeven = 0;
  private grossProfit = 0;
  private grossLoss = 0;
  private totalVolume = 0;

  merge(record: Record<string, any>): void {
    this.totalTrades += record.tradeCount || 0;
    this.wins += record.wins || 0;
    this.losses += record.losses || 0;
    this.breakeven += record.breakeven || 0;
    this.grossProfit += record.grossProfit || 0;
    this.grossLoss += record.grossLoss || 0;
    this.totalVolume += record.totalVolume || 0;
  }

  getResult(_context: AggregationContext) {
    const totalPnl = this.grossProfit - this.grossLoss;
    return {
      totalTrades: this.totalTrades,
      wins: this.wins,
      losses: this.losses,
      breakeven: this.breakeven,
      grossProfit: this.grossProfit,
      grossLoss: this.grossLoss,
      totalPnl,
      totalVolume: this.totalVolume,
      winRate: this.totalTrades > 0 ? (this.wins / this.totalTrades) * 100 : 0,
      profitFactor: this.grossLoss > 0 ? this.grossProfit / this.grossLoss : (this.grossProfit > 0 ? Infinity : 0),
      avgWin: this.wins > 0 ? this.grossProfit / this.wins : 0,
      avgLoss: this.losses > 0 ? this.grossLoss / this.losses : 0,
      expectancy: this.totalTrades > 0 ? totalPnl / this.totalTrades : 0,
    };
  }

  reset(): void {
    this.totalTrades = 0;
    this.wins = 0;
    this.losses = 0;
    this.breakeven = 0;
    this.grossProfit = 0;
    this.grossLoss = 0;
    this.totalVolume = 0;
  }
}
