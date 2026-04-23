import { APIGatewayProxyHandlerV2 } from 'aws-lambda';
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';
import { envelope, errorResponse, ErrorCodes } from '../../shared/validation';
import { getUserId } from '../../shared/auth';
import { checkSubscription } from '../../shared/subscription';

const MODELS = ['gemini-2.5-flash-lite', 'gemini-2.5-flash'];
const GEMINI_API_BASE = 'https://generativelanguage.googleapis.com/v1beta';
const RETRYABLE_STATUS_CODES = [429, 503];

const SYSTEM_PROMPT = `You are a grammar and spelling corrector. Fix grammar, spelling, and punctuation errors in the given text. Keep the original meaning, tone, and wording intact. Do not add, remove, or rephrase content beyond what is needed to correct errors. Return ONLY the corrected text. No explanations, no filler.`;

// Configurable upstream request timeout (ms); default 30000 (30s)
const REQUEST_TIMEOUT_MS = (() => {
  const v = parseInt(process.env.GEMINI_REQUEST_TIMEOUT_MS || '30000', 10);
  return Number.isFinite(v) && v > 0 ? v : 30000;
})();

let cachedApiKey: string | undefined;
let apiKeyExpiry = 0;
const API_KEY_CACHE_TTL = 3600000; // 1 hour
const ssm = new SSMClient({});

async function getApiKey(): Promise<string> {
  if (cachedApiKey && Date.now() < apiKeyExpiry) return cachedApiKey;
  const paramName = process.env.GEMINI_API_KEY_PARAM;
  if (!paramName) throw new Error('Missing GEMINI_API_KEY_PARAM');
  const res = await ssm.send(new GetParameterCommand({ Name: paramName, WithDecryption: true }));
  const v = res.Parameter?.Value;
  if (!v) throw new Error('Gemini API key parameter empty');
  cachedApiKey = v;
  apiKeyExpiry = Date.now() + API_KEY_CACHE_TTL;
  return v;
}

export const handler: APIGatewayProxyHandlerV2 = async (event) => {
  const userId = getUserId(event);

  if (userId) {
    const subError = await checkSubscription(userId);
    if (subError) return subError;
  }

  try {
    if (!event.body) {
      return envelope({ 
        statusCode: 400, 
        error: { code: 'BadRequest', message: 'Missing body' }, 
        message: 'Missing body' 
      });
    }

    let body;
    try {
      body = JSON.parse(event.body);
    } catch (e) {
      return envelope({ 
        statusCode: 400, 
        error: { code: 'BadRequest', message: 'Invalid JSON' }, 
        message: 'Invalid JSON' 
      });
    }

    const { text } = body;
    if (!text || typeof text !== 'string' || !text.trim()) {
      return envelope({ 
        statusCode: 400, 
        error: { code: 'BadRequest', message: 'Missing or empty text field' }, 
        message: 'Missing or empty text field' 
      });
    }

    const apiKey = await getApiKey();
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    try {
      let enhancedText: string | undefined;

      for (let i = 0; i < MODELS.length; i++) {
        const model = MODELS[i];
        const isLast = i === MODELS.length - 1;
        const url = `${GEMINI_API_BASE}/models/${model}:generateContent`;

        const response = await fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-goog-api-key': apiKey,
          },
          body: JSON.stringify({
            contents: [{
              role: 'user',
              parts: [{ text: `${SYSTEM_PROMPT}\n\n${text}` }],
            }],
            generationConfig: {
              temperature: 0.2,
              maxOutputTokens: 2048,
              thinkingConfig: { thinkingBudget: 0 },
            },
          }),
          signal: controller.signal,
        });

        if (!response.ok) {
          const errText = await response.text();
          if (!isLast && RETRYABLE_STATUS_CODES.includes(response.status)) {
            console.warn(`Gemini ${model} returned ${response.status}, falling back to ${MODELS[i + 1]}`);
            continue;
          }
          console.error('Gemini API error:', response.status, errText);
          clearTimeout(timeoutId);
          return envelope({
            statusCode: 502,
            error: { code: 'BadGateway', message: `Gemini API error: ${response.status}` },
            message: 'Failed to enhance text',
          });
        }

        const data = await response.json();
        enhancedText = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
        if (i > 0) console.log(`Used fallback model ${model} successfully`);
        break;
      }

      clearTimeout(timeoutId);

      if (!enhancedText) {
        return envelope({
          statusCode: 502,
          error: { code: 'BadGateway', message: 'Empty response from AI model' },
          message: 'Failed to enhance text',
        });
      }

      return envelope({
        statusCode: 200,
        data: { enhancedText },
      });

    } catch (error: any) {
      clearTimeout(timeoutId);
      if (error.name === 'AbortError') {
        return envelope({
          statusCode: 504,
          error: { code: 'GatewayTimeout', message: 'AI request timed out' },
          message: 'Request timed out',
        });
      }
      throw error;
    }

  } catch (error: any) {
    console.error('Enhance text error:', error);
    return envelope({ 
      statusCode: 500, 
      error: { code: 'InternalServerError', message: error.message || 'Internal Server Error' }, 
      message: 'Internal Server Error' 
    });
  }
};
