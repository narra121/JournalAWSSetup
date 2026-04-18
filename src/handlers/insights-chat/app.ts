import { APIGatewayProxyHandlerV2 } from 'aws-lambda';
import { getUserId } from '../../shared/auth';
import { getSubscriptionTier } from '../../shared/subscription';
import { envelope, errorResponse, ErrorCodes } from '../../shared/validation';
import { getApiKey, callGemini } from '../../shared/insights/gemini';
import { fetchTrades, fetchAggregatedStats } from '../../shared/insights/fetch-data';

const REQUEST_TIMEOUT_MS = 25000; // 25s for chat (shorter than insights)

interface ChatRequest {
  message: string;
  accountId?: string;
  startDate: string;
  endDate: string;
  history?: Array<{ role: string; content: string }>;
}

export const handler: APIGatewayProxyHandlerV2 = async (event) => {
  try {
    const userId = getUserId(event);
    if (!userId) return errorResponse(401, ErrorCodes.UNAUTHORIZED, 'Unauthorized');

    // Subscription gate
    const tierResult = await getSubscriptionTier(userId);
    if (tierResult.tier === 'free_with_ads') {
      return errorResponse(403, ErrorCodes.SUBSCRIPTION_REQUIRED, 'AI Chat requires a premium subscription');
    }

    // Parse request
    if (!event.body) return errorResponse(400, ErrorCodes.VALIDATION_ERROR, 'Missing request body');
    let request: ChatRequest;
    try {
      request = JSON.parse(event.body);
    } catch {
      return errorResponse(400, ErrorCodes.VALIDATION_ERROR, 'Invalid JSON');
    }

    const { message, accountId: rawAccountId, startDate, endDate, history } = request;
    if (!message || !startDate || !endDate) {
      return errorResponse(400, ErrorCodes.VALIDATION_ERROR, 'message, startDate, and endDate are required');
    }

    const accountId = rawAccountId && rawAccountId !== 'ALL' ? rawAccountId : undefined;

    // Fetch trade context (lightweight — just stats + top/bottom trades)
    const [trades, stats] = await Promise.all([
      fetchTrades(userId, startDate, endDate, accountId),
      fetchAggregatedStats(userId, startDate, endDate, accountId),
    ]);

    // Build compact trade summary (not full dump — too expensive for chat)
    const sortedByPnl = [...trades].sort((a, b) => (b.pnl ?? 0) - (a.pnl ?? 0));
    const topTrades = sortedByPnl.slice(0, 5).map(t => ({
      symbol: t.symbol,
      pnl: t.pnl,
      date: t.openDate?.slice(0, 10),
      strategy: t.setupType || t.strategy,
    }));
    const bottomTrades = sortedByPnl.slice(-5).map(t => ({
      symbol: t.symbol,
      pnl: t.pnl,
      date: t.openDate?.slice(0, 10),
      strategy: t.setupType || t.strategy,
    }));

    // Symbol distribution
    const symbolCounts = new Map<string, { count: number; pnl: number; wins: number }>();
    for (const t of trades) {
      const s = symbolCounts.get(t.symbol) || { count: 0, pnl: 0, wins: 0 };
      s.count++;
      s.pnl += t.pnl ?? 0;
      if ((t.pnl ?? 0) > 0) s.wins++;
      symbolCounts.set(t.symbol, s);
    }
    const topSymbols = [...symbolCounts.entries()]
      .sort((a, b) => b[1].count - a[1].count)
      .slice(0, 10)
      .map(([symbol, data]) => ({
        symbol,
        ...data,
        winRate: data.count > 0 ? Math.round((data.wins / data.count) * 100) : 0,
      }));

    // Build system prompt
    const systemPrompt = `You are a trading performance analyst chatbot. You have access to the trader's data for the period ${startDate} to ${endDate}.

TRADE DATA SUMMARY:
- Total trades: ${trades.length}
- Aggregated stats: ${JSON.stringify(stats, null, 2)}
- Top symbols: ${JSON.stringify(topSymbols)}
- Best 5 trades: ${JSON.stringify(topTrades)}
- Worst 5 trades: ${JSON.stringify(bottomTrades)}

RULES:
- Answer questions about the trader's performance using the data above.
- Be specific — cite numbers, percentages, and trade examples.
- Keep responses concise (2-4 sentences for simple questions, up to a paragraph for complex ones).
- If the data doesn't contain enough info to answer, say so honestly.
- At the end of your response, on a new line, add a JSON array of 2-3 suggested follow-up questions wrapped in <suggestions> tags, like: <suggestions>["Question 1?", "Question 2?"]</suggestions>
- Never reveal raw data dumps — summarize and interpret.`;

    // Build messages array for Gemini
    const conversationHistory = (history || []).slice(-10); // Keep last 10 messages
    const fullPrompt = `${systemPrompt}\n\nConversation so far:\n${conversationHistory.map(m => `${m.role}: ${m.content}`).join('\n')}\n\nuser: ${message}\n\nassistant:`;

    // Call Gemini
    const apiKey = await getApiKey();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    let rawResponse: string;
    try {
      rawResponse = await callGemini(apiKey, fullPrompt, controller.signal);
    } finally {
      clearTimeout(timeout);
    }

    // Extract suggestions if present
    let reply = rawResponse.trim();
    let suggestedQuestions: string[] | undefined;
    const suggestionsMatch = reply.match(/<suggestions>\s*(\[[\s\S]*?\])\s*<\/suggestions>/);
    if (suggestionsMatch) {
      try {
        suggestedQuestions = JSON.parse(suggestionsMatch[1]);
        reply = reply.replace(/<suggestions>[\s\S]*?<\/suggestions>/, '').trim();
      } catch {
        /* ignore parse errors */
      }
    }

    return envelope({
      statusCode: 200,
      data: { reply, suggestedQuestions },
      message: 'Chat response generated',
    });
  } catch (error: any) {
    console.error('Insights chat error', error);
    return errorResponse(500, ErrorCodes.INTERNAL_ERROR, 'Failed to generate chat response', error.message);
  }
};
