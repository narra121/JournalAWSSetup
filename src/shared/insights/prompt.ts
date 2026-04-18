import { AggregatedStats } from '../metrics/types';
import type { PatternDetectionResult } from '../pattern-detector/types';

// ---- Trade Stripping ----

/**
 * Strip heavy fields from trades before sending to Gemini to reduce token count.
 * Removes images array, truncates notes to 100 chars, removes long keyLesson.
 */
export function stripTradeForLLM(trade: any): any {
  const stripped: any = { ...trade };

  // Remove images array entirely
  delete stripped.images;

  // Truncate notes to 100 characters
  if (stripped.notes && typeof stripped.notes === 'string' && stripped.notes.length > 100) {
    stripped.notes = stripped.notes.slice(0, 100) + '...';
  }

  // Remove keyLesson if very long (>200 chars)
  if (stripped.keyLesson && typeof stripped.keyLesson === 'string' && stripped.keyLesson.length > 200) {
    delete stripped.keyLesson;
  }

  // Remove other heavy/unnecessary fields
  delete stripped.userId;

  return stripped;
}

// ---- Prompt Builder ----

export function buildInsightsPrompt(stats: AggregatedStats, trades: any[], patterns?: PatternDetectionResult): string {
  let patternSection = '';

  if (patterns) {
    const patternSummary = {
      revengeTrades: patterns.revengeTrades.length,
      revengeTradesCost: patterns.costOfEmotion.revengeTrading.totalPnl,
      overtradeDays: patterns.overtradeDays.length,
      longestWinStreak: patterns.longestWinStreak?.length ?? 0,
      longestLossStreak: patterns.longestLossStreak?.length ?? 0,
      currentStreak: patterns.currentStreak ? `${patterns.currentStreak.length} ${patterns.currentStreak.type}s` : 'none',
      costOfEmotion: patterns.costOfEmotion,
      greenZoneHours: patterns.hourlyEdges.filter(h => h.label === 'green_zone').map(h => h.hour),
      redZoneHours: patterns.hourlyEdges.filter(h => h.label === 'red_zone').map(h => h.hour),
      greenZoneDays: patterns.dayOfWeekEdges.filter(d => d.label === 'green_zone').map(d => d.dayName),
      redZoneDays: patterns.dayOfWeekEdges.filter(d => d.label === 'red_zone').map(d => d.dayName),
    };

    patternSection = `DETERMINISTIC PATTERN ANALYSIS (computed from data — DO NOT contradict these findings):
${JSON.stringify(patternSummary, null, 2)}

IMPORTANT: You MUST reference the above pattern data in your insights:
- If revengeTrades > 0, include a revenge trading insight with severity based on count and cost.
- If costOfEmotion.totalEmotionalCost < -50, flag it as critical severity.
- If overtradeDays > 0, mention overtrading pattern.
- If redZoneHours exist, recommend avoiding those hours.
- If greenZoneHours exist, recommend focusing on those hours.
- If longestLossStreak > 3, flag it as a warning about drawdown risk.

`;
  }

  return `ROLE:
You are an expert trading performance analyst. Your goal is to analyze the trader's historical data and produce a structured, actionable JSON response. Be specific, reference real data points, and cite individual trades by their tradeId when relevant.

TRADER PROFILING RULES:
Classify the trader into exactly one profile based on observed data patterns:

1. SCALPER (High-Frequency):
   - Signals: 5+ trades/day average, average hold time <1 hour, tight risk-reward (1:1 to 1.5:1), small gaps between trades
   - Focus insights on: overtrading detection, revenge trading, commission drag, fatigue patterns, best trading hours

2. DAY_TRADER:
   - Signals: 1-5 trades/day average, hold time 30min-8hrs, moderate risk-reward (1.5:1 to 2.5:1), trades within sessions
   - Focus insights on: session performance, strategy consistency, position sizing discipline, daily P&L targets

3. SWING_TRADER:
   - Signals: 2-10 trades/week average, hold time 1-14 days, wider risk-reward (2:1 to 4:1), gaps between trades
   - Focus insights on: entry timing, patience, holding through volatility, trend alignment

4. CONSERVATIVE (Low-Frequency):
   - Signals: <2 trades/week, high risk-reward (3:1+), low risk %, selective entries, long gaps between trades
   - Focus insights on: missed opportunities, entry quality, capital utilization, patience rewards

AGGRESSIVENESS SCORE (1-10):
Compute from these weighted factors relative to the trader's profile type:
- Trade frequency relative to profile norm
- Position sizing consistency and outliers
- Risk-reward ratio distribution
- Max drawdown severity
- Consecutive loss behavior (revenge trading signals)
- Rule-breaking frequency (if rule data available)
- Gap between trades (impulse trading detection)

Score interpretation:
- 1-3: "Conservative" — focus on capital utilization, scaling up safely
- 4-5: "Balanced" — focus on consistency, fine-tuning strategy
- 6-7: "Aggressive" — focus on risk management, drawdown control
- 8-10: "Very Aggressive" — focus on survival, risk reduction, emotional control

BEHAVIORAL SCORING (0-100 each):
Score these five dimensions based on the data:
- discipline: Following rules, sticking to plans, consistent behavior
- risk_management: Position sizing, stop losses, drawdown control
- consistency: Regularity of trading patterns, strategy adherence
- patience: Waiting for setups, not overtrading, appropriate hold times
- emotional_control: Revenge trading absence, consistency after losses, no tilt behavior

INSIGHT SEVERITY LEVELS:
- critical: Immediate action needed — patterns that are actively harmful
- warning: Concerning pattern that needs attention
- info: Neutral observation or suggestion for improvement
- strength: Positive reinforcement of good behavior

TRADE SPOTLIGHTS:
Highlight 3-5 notable trades: the best trade, the worst trade, and 1-3 trades that exemplify patterns you identified. Always include tradeId, symbol, date, pnl, and a reason explaining why this trade was highlighted.

RESPONSE JSON SCHEMA (you MUST return ONLY valid JSON matching this exact structure):
{
  "profile": {
    "type": "scalper" | "day_trader" | "swing_trader" | "conservative",
    "typeLabel": "string (Human-readable label, e.g. 'Day Trader')",
    "aggressivenessScore": "number (1-10)",
    "aggressivenessLabel": "string ('Conservative' | 'Balanced' | 'Aggressive' | 'Very Aggressive')",
    "trend": "string | null (e.g. 'up_from_5.4', 'stable', 'down_from_7.1'; null for first analysis)",
    "summary": "string (One-line profile summary)"
  },
  "scores": [
    {
      "dimension": "string (one of: discipline, risk_management, consistency, patience, emotional_control)",
      "value": "number (0-100)",
      "label": "string (Human-readable dimension name, e.g. 'Risk Management')"
    }
  ],
  "insights": [
    {
      "severity": "critical" | "warning" | "info" | "strength",
      "title": "string (Short headline)",
      "detail": "string (Explanation with evidence)",
      "evidence": "string (Specific data point backing the insight)",
      "tradeIds": ["string (optional, specific trade IDs referenced)"]
    }
  ],
  "tradeSpotlights": [
    {
      "tradeId": "string",
      "symbol": "string",
      "date": "string (ISO date)",
      "pnl": "number",
      "reason": "string (Why this trade was highlighted)"
    }
  ],
  "summary": "string (One-paragraph overall assessment)"
}

STRICT OUTPUT RULES:
- Return ONLY valid JSON. No markdown fences, no leading/trailing text, no explanations.
- The "scores" array must contain exactly 5 entries, one for each dimension listed above.
- The "insights" array should contain 4-8 insights, severity-ordered (critical first, then warning, info, strength).
- The "tradeSpotlights" array should contain 3-5 entries.
- Only include tradeIds in insights if you are referencing specific trades.
- All numeric values must be actual numbers, not strings.
- trend should be null since this is a standalone analysis.

${patternSection}AGGREGATED STATS:
${JSON.stringify(stats, null, 2)}

TRADE DATA (${trades.length} trades):
${JSON.stringify(trades, null, 2)}`;
}
