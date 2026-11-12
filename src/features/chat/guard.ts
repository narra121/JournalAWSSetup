// Requests for buy/sell/hold advice, entries/targets, tips or forecasts are refused without calling the model
// (SEBI: TradeQut is not a registered investment adviser / research analyst). Patterns are deliberately
// narrow: questions about the user's own past trades must pass.
const ADVICE_PATTERNS: RegExp[] = [
  /\b(should|shall|must|can|could)\s+(i|we|one)\b[^.?!\n]{0,60}\b(buy|sell|short|invest|go long|go short)\b/i,
  /\b(what|which)\s+(stocks?|shares?|options?|strikes?|scrips?|coins?|cryptos?|futures?|pairs?|etfs?|mutual funds?|funds?)\b[^.?!\n]{0,30}\b(should|to|can|will|would|is best|are best)\b/i,
  /\b(give|suggest|recommend|send|share)\b[^.?!\n]{0,40}\b(tips?|entry|entries|targets?|levels?|picks?|calls?|stocks?|strikes?|trade ideas?)\b/i,
  /\b(will|would|is|are)\b[^.?!\n]{0,40}\b(go up|go down|rise|fall|crash|rally|break ?out|hit|reach)\b[^.?!\n]{0,30}\b(tomorrow|today|next|this week|this month|soon|by)\b/i,
  /\b(buy|sell)\s+or\s+(sell|hold|buy)\b/i,
  /\b(price target|price prediction|predict(ion)? (the )?(price|market|nifty|banknifty|sensex))\b/i,
  /\b(kya|kaunsa|konsa|kaun sa)\b[^.?!\n]{0,40}\b(khareed\w*|kharid\w*|bech\w*|le lu|buy|sell)\b/i,
  /\b(kharidu|kharidun|kharide|bechu|bechun|beche)\b/i,
  /\b(tips?|calls?)\s+(do|dijiye|dedo|batao|bhejo)\b/i,
  /\b(batao|bataiye|bata do)\b[^.?!\n]{0,30}\b(stock|share|option|strike|target|entry)\b/i,
];

export function isAdviceRequest(text: string): boolean {
  return ADVICE_PATTERNS.some((p) => p.test(text));
}

export const DISCLAIMER =
  'Analysis of your own past trades for education only. Not investment advice; TradeQut is not a SEBI-registered investment adviser or research analyst.';

export const ADVICE_REFUSAL =
  "I can't recommend buying, selling or holding any security, and I don't give entries, targets, tips or forecasts. " +
  'TradeQut is not a SEBI-registered investment adviser, so this is not investment advice. ' +
  'What I can do is analyse your own past trades, for example how your option trades performed by time of day, ' +
  'which setups cost you the most, or what happened after losing streaks. What would you like to look at?';
