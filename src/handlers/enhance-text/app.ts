import type { ApiHandler } from '../../shared/types';
import { envelope, errorFromException, errorResponse, ErrorCodes } from '../../shared/validation';
import { getUserId } from '../../shared/auth';
import { generateText, geminiTimeoutMs } from '../../shared/gemini';
import { logAiCall } from '../../features/ai/log';

const SYSTEM_PROMPT = `You are a grammar and spelling corrector. Fix grammar, spelling, and punctuation errors in the given text. Keep the original meaning, tone, and wording intact. Do not add, remove, or rephrase content beyond what is needed to correct errors. Return ONLY the corrected text. No explanations, no filler.`;

// Configurable upstream request timeout (ms); default 30000 (30s)
const REQUEST_TIMEOUT_MS = geminiTimeoutMs(30000);
// The corrected text is about as long as the input (up to MAX_TEXT_LENGTH characters).
const MAX_OUTPUT_TOKENS = 8192;

const MAX_TEXT_LENGTH = 10_000;
const AI_UNAVAILABLE = "The text improver isn't available right now. Please try again in a moment.";

export const handler: ApiHandler = async (event) => {
  const userId = getUserId(event);

  if (!userId) return errorResponse(401, ErrorCodes.UNAUTHORIZED, 'Unauthorized');

  try {
    if (!event.body) {
      return errorResponse(400, ErrorCodes.VALIDATION_ERROR, 'Type or paste some text to improve.');
    }

    let body;
    try {
      body = JSON.parse(event.body);
    } catch (e) {
      return errorResponse(400, ErrorCodes.VALIDATION_ERROR, 'The request body must be valid JSON.');
    }

    const { text } = body;
    if (!text || typeof text !== 'string' || !text.trim()) {
      return errorResponse(400, ErrorCodes.VALIDATION_ERROR, 'Type or paste some text to improve.');
    }

    if (text.length > MAX_TEXT_LENGTH) {
      return errorResponse(400, ErrorCodes.VALIDATION_ERROR, `That text is too long. The limit is ${MAX_TEXT_LENGTH.toLocaleString('en-US')} characters.`);
    }

    let result;
    try {
      result = await generateText({
        parts: [{ text: `${SYSTEM_PROMPT}

${text}` }],
        maxOutputTokens: MAX_OUTPUT_TOKENS,
        temperature: 0.2,
        timeoutMs: REQUEST_TIMEOUT_MS,
      });
    } catch (error: any) {
      if (error.name === 'AbortError') {
        return errorResponse(504, ErrorCodes.GATEWAY_TIMEOUT, 'The text improver took too long. Please try again.');
      }
      if (error.name === 'GeminiHttpError' || error.message === 'Gemini returned empty response') {
        console.error('Enhance text model error:', error.message);
        return errorResponse(502, ErrorCodes.BAD_GATEWAY, AI_UNAVAILABLE);
      }
      throw error;
    }

    // A reply cut off at the token limit (or blocked) would overwrite the user's note with a partial text.
    if (result.finishReason && result.finishReason !== 'STOP') {
      console.error('Enhance text incomplete reply', { finishReason: result.finishReason });
      return errorResponse(502, ErrorCodes.BAD_GATEWAY, AI_UNAVAILABLE);
    }

    logAiCall('enhance', result.model, undefined, { requestId: event.requestContext?.requestId, userId });
    return envelope({
      statusCode: 200,
      data: { enhancedText: result.text },
    });
  } catch (error: any) {
    console.error('Enhance text error:', error);
    return errorFromException(error);
  }
};
