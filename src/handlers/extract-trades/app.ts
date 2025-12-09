import { APIGatewayProxyHandlerV2 } from 'aws-lambda';
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';

const MODEL_ID = 'google/gemini-2.0-flash-001';


const GEMINI_VISION_PROMPT = `ROLE:
You are an expert VISION + OCR financial data extraction model. Your ONLY goal is to read the trade history TABLE shown in the provided image and output a precise structured JSON array. You must be completely accurate and not hallucinate any data.

TARGET SCHEMA (array of objects, order preserved top-to-bottom as in the table):
json
[
  {
    "symbol": "STRING",
    "side": "BUY|SELL",
    "quantity": NUMBER,
    "openDate": "YYYY-MM-DDTHH:MM:SS",
    "closeDate": "YYYY-MM-DDTHH:MM:SS",
    "entryPrice": NUMBER,
    "exitPrice": NUMBER,
    "stopLoss": NUMBER,
    "takeProfit": NUMBER,
    "pnl": NUMBER
  }
]


FIELD INTERPRETATION:
- symbol: Instrument ticker exactly as shown (e.g., XAUUSD). Uppercase if clearly uppercase; do NOT invent.
- side: MUST be BUY or SELL (map LONG -> BUY, SHORT -> SELL if those appear). If ambiguous, skip the row.
- quantity: Numeric size/lot. If unreadable, skip the row (do not guess). Accept decimals.
- openDate / closeDate: See DATE COMPLETION ALGORITHM below.
- entryPrice / exitPrice: Prices as decimals. Strip currency symbols ($, €) and commas. If a thousands separator or decimal point appears, interpret according to standard US/ISO formatting (e.g., 3,344.78 -> 3344.78).
- stopLoss: Stop loss price. If absent or blank, default to 0.
- takeProfit: Take profit price. If absent or blank, default to 0.
- pnl: Profit/Loss value for that row. Preserve sign. Parentheses or a leading minus sign means negative. If colored red and no sign, assume negative.

DATE COMPLETION ALGORITHM (CRITICAL):
For this task, the current date is August 25, 2025. Use these components to complete any missing date information:
- CurrentYear: \`2025\`
- CurrentMonth: \`08\`
- CurrentDay: \`25\`

1. Full Datetime Provided: If a cell has a full datetime with a 4-digit year (e.g., \`2024-12-15 17:18\`), use it exactly as provided, even if the year is not 2025.
2. Year is Missing: If a cell has a month and day but no year (e.g., \`08-20 17:18\`), complete it using \`CurrentYear\`. Result: \`2025-08-20T17:18:00\`.
3. Year and Month are Missing: If a cell has only a time (e.g., \`17:01\`), complete it using \`CurrentYear\`, \`CurrentMonth\`, and \`CurrentDay\`. Result: \`2025-08-25T17:01:00\`.
4. Formatting: Always output the full ISO 8601 format: \`YYYY-MM-DDTHH:MM:SS\`. If seconds are missing, use \`:00\`.
5. Blank Close Date: If the close date/time cell is blank, set \`closeDate\` to be the same as the \`openDate\`.

MISSING / BLANK HANDLING:
- Required Fields: A valid row must contain \`symbol\`, \`side\`, \`quantity\`, and an open date/time. If any of these are unreadable, SKIP the entire row.
- Optional Numeric Fields: If \`entryPrice\`, \`exitPrice\`, \`stopLoss\`, \`takeProfit\`, or \`pnl\` are blank, set them to \`0\`. However, if both \`entryPrice\` and \`exitPrice\` are blank, skip the row as it is likely not a valid trade.

NORMALIZATION & VALIDATION:
- Strip leading/trailing whitespace from all text fields.
- Convert \`stopLoss\`, \`takeProfit\`, \`pnl\`, and \`quantity\` to numbers.
- Do not compute or adjust \`pnl\`; use exactly the value displayed in the image.
- If duplicate rows appear, keep them as separate entries unless they are clear visual OCR artifacts of the exact same row.

VISION-SPECIFIC GUIDANCE:
- Pay close attention to column alignment to correctly identify fields.
- Ignore all UI elements like buttons, icons, sort arrows, or checkboxes.
- Ignore columns not present in the target schema (e.g., Status, Order ID, Commission, Fees, Swap).
- If a currency symbol precedes a price (e.g., $3343.24), drop the symbol.

STRICT OUTPUT RULES:
- Return ONLY a valid JSON array.
- Do not include any leading/trailing text, explanations, or markdown fences (\`\`\`json\`\`\`).
- Every object in the array must include all keys defined in the schema.
- Ensure keys in each object follow this exact order: \`symbol\`, \`side\`, \`quantity\`, \`openDate\`, \`closeDate\`, \`entryPrice\`, \`exitPrice\`, \`stopLoss\`, \`takeProfit\`, \`pnl\`.
- Do not use trailing commas in the JSON.
- If no valid trade rows can be extracted, output an empty array \`[]\`.`;
// Configurable upstream request timeout (ms) for Gemini fetch; default 80000 (80s)
const REQUEST_TIMEOUT_MS = (() => {
  const v = parseInt(process.env.GEMINI_REQUEST_TIMEOUT_MS || '80000', 10);
  return Number.isFinite(v) && v > 0 ? v : 8000;
})();
// Hard cap on accepted base64 payload bytes (after stripping data URI) to prevent very large images (default ~3MB)
const MAX_IMAGE_BASE64_LENGTH = (() => {
  const v = parseInt(process.env.MAX_IMAGE_BASE64_LENGTH || '4000000', 10); // 4,000,000 chars ~3MB decoded
  return Number.isFinite(v) && v > 10000 ? v : 4000000;
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

function response(statusCode: number, body: any) {
  return { statusCode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
}

export const handler: APIGatewayProxyHandlerV2 = async (event) => {
  try {
    if (!event.body) return response(400, { error: { code: 'BadRequest', message: 'Missing body' }, data: null, meta: { requestTimeoutMs: REQUEST_TIMEOUT_MS } });
    
    let images: string[] = [];
    try {
      const parsed = JSON.parse(event.body);
      // Support both single image (imageBase64) and multiple images (images array)
      if (parsed.imageBase64 && typeof parsed.imageBase64 === 'string') {
        images = [parsed.imageBase64];
      } else if (parsed.images && Array.isArray(parsed.images)) {
        images = parsed.images;
      }
    } catch {
      return response(400, { error: { code: 'BadJSON', message: 'Body must be JSON' }, data: null, meta: null });
    }
    
    if (images.length === 0) {
      return response(400, { error: { code: 'BadRequest', message: 'imageBase64 or images array required' }, data: null, meta: null });
    }
    
    if (images.length > 3) {
      return response(400, { error: { code: 'BadRequest', message: 'Maximum 3 images allowed' }, data: null, meta: { maxImages: 3 } });
    }

    const started = Date.now();
    let apiKey: string;
    try {
      apiKey = await getApiKey();
    } catch (e: any) {
      return response(500, { error: { code: 'ConfigError', message: e.message }, data: null, meta: null });
    }

    // Process each image and collect all extracted trades
    const allItems: any[] = [];
    const processingDetails: any[] = [];

    for (let i = 0; i < images.length; i++) {
      const imageBase64 = images[i];
      
      // Strip possible data URI prefix
      const cleaned = imageBase64.replace(/^data:image\/[a-zA-Z0-9+.-]+;base64,/, '');
      
      if (cleaned.length > MAX_IMAGE_BASE64_LENGTH) {
        processingDetails.push({
          imageIndex: i,
          error: `Image base64 length ${cleaned.length} exceeds limit ${MAX_IMAGE_BASE64_LENGTH}`,
          skipped: true
        });
        continue;
      }

      console.log(`ExtractTrades processing image ${i + 1}/${images.length}`, { sizeChars: cleaned.length });

      let text: string;
      try {
        console.log('Calling OpenRouter API with Gemini model', { model: MODEL_ID, imageIndex: i });
        
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
        
        const fetchResponse = await fetch('https://openrouter.ai/api/v1/chat/completions', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
            'HTTP-Referer': process.env.HTTP_REFERER || 'https://tradehaven.app',
            'X-Title': 'Trading Journal'
          },
          body: JSON.stringify({
            model: MODEL_ID,
            messages: [
              {
                role: 'user',
                content: [
                  {
                    type: 'text',
                    text: GEMINI_VISION_PROMPT
                  },
                  {
                    type: 'image_url',
                    image_url: {
                      url: `data:image/png;base64,${cleaned}`
                    }
                  }
                ]
              }
            ]
          }),
          signal: controller.signal
        });
        
        clearTimeout(timeoutId);
        
        if (!fetchResponse.ok) {
          const errorText = await fetchResponse.text();
          throw new Error(`OpenRouter API error: ${fetchResponse.status} ${fetchResponse.statusText} - ${errorText}`);
        }
        
        const data = await fetchResponse.json();
        text = data.choices[0].message.content.trim();
      } catch (err: any) {
        const imageElapsed = Date.now() - started;
        const isAbort = err?.name === 'AbortError' || /aborted/i.test(err?.message || '');
        console.error(`OpenRouter API call failed for image ${i}`, { elapsedMs: imageElapsed, isAbort, error: err?.message });
        
        processingDetails.push({
          imageIndex: i,
          error: isAbort ? `Timeout after ${REQUEST_TIMEOUT_MS}ms` : err?.message || 'OpenRouter API call failed',
          skipped: true
        });
        
        // If this is the only image and it failed, return error immediately
        if (images.length === 1) {
          return response(500, { 
            error: { 
              code: isAbort ? 'OpenRouterTimeout' : 'OpenRouterError', 
              message: isAbort ? `Request timeout after ${REQUEST_TIMEOUT_MS}ms` : (err?.message || 'OpenRouter API call failed')
            }, 
            data: null, 
            meta: { elapsedMs: imageElapsed } 
          });
        }
        continue;
      }

      console.log(`OpenRouter response received for image ${i}`, { chars: text.length });

      const extracted = extractJsonArray(text);
      if (!extracted.json) {
        processingDetails.push({
          imageIndex: i,
          error: 'Model did not return JSON array',
          rawPreview: text.slice(0, 200),
          skipped: true
        });
        continue;
      }

      let items: any[];
      try {
        items = JSON.parse(extracted.json);
        allItems.push(...items);
        processingDetails.push({
          imageIndex: i,
          extractedCount: items.length,
          parseSteps: extracted.steps
        });
      } catch (e: any) {
        processingDetails.push({
          imageIndex: i,
          error: `JSON parse error: ${e.message}`,
          skipped: true
        });
      }
    }

    const elapsed = Date.now() - started;
    
    // If all images failed to process, return error
    const allFailed = processingDetails.every(d => d.skipped === true);
    if (allFailed && processingDetails.length > 0) {
      return response(500, { 
        error: { 
          code: 'ExtractionFailed', 
          message: 'All images failed to process',
          details: processingDetails
        }, 
        data: null, 
        meta: { elapsedMs: elapsed, totalImages: images.length } 
      });
    }
    
    return response(200, { 
      data: { items: allItems }, 
      meta: { 
        elapsedMs: elapsed, 
        totalImages: images.length,
        totalExtracted: allItems.length,
        processingDetails 
      }, 
      error: null 
    });
  } catch (e: any) {
    console.error('ExtractTrades error', e);
    return response(500, { error: { code: 'InternalError', message: e?.message || 'Unexpected error' }, data: null, meta: null });
  }
};

function extractJsonArray(raw: string): { json?: string; steps: string[] } {
  const steps: string[] = [];
  let work = raw.trim();
  // 1. Strip markdown code fences if present
  const fenceMatch = work.match(/```(?:json)?\s*[\r\n]+([\s\S]*?)```/i);
  if (fenceMatch) {
    steps.push('Stripped markdown code fence');
    work = fenceMatch[1].trim();
  }
  // 2. Direct check
  if (work.startsWith('[') && work.endsWith(']')) {
    steps.push('Detected array boundaries directly');
    return { json: work, steps };
  }
  // 3. Attempt to locate first JSON array via bracket balancing
  const firstOpen = work.indexOf('[');
  if (firstOpen !== -1) {
    let depth = 0;
    for (let i = firstOpen; i < work.length; i++) {
      const ch = work[i];
      if (ch === '[') depth++;
      else if (ch === ']') {
        depth--;
        if (depth === 0) {
          const candidate = work.slice(firstOpen, i + 1).trim();
          if (candidate.startsWith('[') && candidate.endsWith(']')) {
            steps.push('Extracted balanced array slice');
            return { json: candidate, steps };
          }
          break;
        }
      }
    }
  }
  return { steps };
}
