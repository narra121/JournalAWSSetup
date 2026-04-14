import { APIGatewayProxyHandlerV2 } from 'aws-lambda';
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';
import { envelope, errorResponse, ErrorCodes } from '../../shared/validation';
import { getUserId } from '../../shared/auth';
import { checkSubscription } from '../../shared/subscription';

const MODEL_ID = 'google/gemini-2.0-flash-lite-001';

const getSystemPrompt = (isTradingNotes: boolean) => {
  const basePrompt = `You are an expert trading journal assistant. Your task is to enhance the following text (trade note or image description). Improve grammar, clarity, and flow, but CRITICALLY, you must preserve the user's first-person narrative and the original emotional state (whether frustration, excitement, calm, or regret). Do not sanitize the emotion or make it sound overly formal. The goal is for the user to read this later and vividly recall their mindset and feelings at that moment.`;
  
  const motivationalPrompt = isTradingNotes 
    ? `\n\nAfter enhancing the text, add a double line break and append ONE short, powerful, and contextually relevant motivational quote (e.g., on discipline, patience, resilience, or humility).`
    : '';
  
  return basePrompt + motivationalPrompt + `\n\nReturn ONLY the enhanced text${isTradingNotes ? ' followed by the quote' : ''}. No conversational filler.`;
};

// Configurable upstream request timeout (ms) for Gemini fetch; default 30000 (30s)
const REQUEST_TIMEOUT_MS = (() => {
  const v = parseInt(process.env.GEMINI_REQUEST_TIMEOUT_MS || '30000', 10);
  return Number.isFinite(v) && v > 0 ? v : 30000;
})();

let cachedApiKey: string | undefined;
const ssm = new SSMClient({});

async function getApiKey(): Promise<string> {
  if (cachedApiKey) return cachedApiKey;
  const paramName = process.env.OPENROUTER_API_KEY_PARAM || process.env.GEMINI_API_KEY_PARAM;
  if (!paramName) throw new Error('Missing OPENROUTER_API_KEY_PARAM or GEMINI_API_KEY_PARAM');
  const res = await ssm.send(new GetParameterCommand({ Name: paramName, WithDecryption: true }));
  const v = res.Parameter?.Value;
  if (!v) throw new Error('OpenRouter API key parameter empty');
  cachedApiKey = v;
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

    const { text, isTradingNotes = false } = body;
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
      const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${apiKey}`,
          "HTTP-Referer": "https://trading-journal.com", // Placeholder
          "X-Title": "Trading Journal",
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          "model": MODEL_ID,
          "messages": [
            {
              "role": "system",
              "content": getSystemPrompt(isTradingNotes)
            },
            {
              "role": "user",
              "content": text
            }
          ]
        }),
        signal: controller.signal
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        const errText = await response.text();
        console.error('OpenRouter API error:', response.status, errText);
        return envelope({ 
          statusCode: 502, 
          error: { code: 'BadGateway', message: `OpenRouter API error: ${response.status}` }, 
          message: 'Failed to enhance text' 
        });
      }

      const data = await response.json();
      const enhancedText = data.choices?.[0]?.message?.content?.trim();

      if (!enhancedText) {
        return envelope({ 
          statusCode: 502, 
          error: { code: 'BadGateway', message: 'Empty response from AI model' }, 
          message: 'Failed to enhance text' 
        });
      }

      return envelope({
        statusCode: 200,
        data: { enhancedText }
      });

    } catch (error: any) {
      clearTimeout(timeoutId);
      if (error.name === 'AbortError') {
        return envelope({ 
          statusCode: 504, 
          error: { code: 'GatewayTimeout', message: 'AI request timed out' }, 
          message: 'Request timed out' 
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
