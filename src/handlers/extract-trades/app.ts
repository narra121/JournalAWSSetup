import { APIGatewayProxyHandlerV2 } from 'aws-lambda';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';

const MODEL_ID = 'gemini-2.0-flash';


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
    "fee": NUMBER,
    "swap": NUMBER,
    "pnl": NUMBER
  }
]


FIELD INTERPRETATION:
- symbol: Instrument ticker exactly as shown (e.g., XAUUSD). Uppercase if clearly uppercase; do NOT invent.
- side: MUST be BUY or SELL (map LONG -> BUY, SHORT -> SELL if those appear). If ambiguous, skip the row.
- quantity: Numeric size/lot. If unreadable, skip the row (do not guess). Accept decimals.
- openDate / closeDate: See DATE COMPLETION ALGORITHM below.
- entryPrice / exitPrice: Prices as decimals. Strip currency symbols ($, €) and commas. If a thousands separator or decimal point appears, interpret according to standard US/ISO formatting (e.g., 3,344.78 -> 3344.78).
- fee: Commission or fee column value. Preserve sign. If shown in parenthesis (0.80), treat as -0.80. If blank, default to 0.
- swap: Overnight swap/financing. If absent or blank, default to 0.
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
- Optional Numeric Fields: If \`entryPrice\`, \`exitPrice\`, \`fee\`, \`swap\`, or \`pnl\` are blank, set them to \`0\`. However, if both \`entryPrice\` and \`exitPrice\` are blank, skip the row as it is likely not a valid trade.

NORMALIZATION & VALIDATION:
- Strip leading/trailing whitespace from all text fields.
- Convert \`fee\`, \`swap\`, \`pnl\`, and \`quantity\` to numbers.
- Do not compute or adjust \`pnl\`; use exactly the value displayed in the image.
- If duplicate rows appear, keep them as separate entries unless they are clear visual OCR artifacts of the exact same row.

VISION-SPECIFIC GUIDANCE:
- Pay close attention to column alignment to correctly identify fields.
- Ignore all UI elements like buttons, icons, sort arrows, or checkboxes.
- Ignore columns not present in the target schema (e.g., Status, Order ID).
- If a currency symbol precedes a price (e.g., $3343.24), drop the symbol.

STRICT OUTPUT RULES:
- Return ONLY a valid JSON array.
- Do not include any leading/trailing text, explanations, or markdown fences (\`\`\`json\`\`\`).
- Every object in the array must include all keys defined in the schema.
- Ensure keys in each object follow this exact order: \`symbol\`, \`side\`, \`quantity\`, \`openDate\`, \`closeDate\`, \`entryPrice\`, \`exitPrice\`, \`fee\`, \`swap\`, \`pnl\`.
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
  const paramName = process.env.GEMINI_API_KEY_PARAM;
  if (!paramName) throw new Error('Missing GEMINI_API_KEY_PARAM');
  const res = await ssm.send(new GetParameterCommand({ Name: paramName, WithDecryption: true }));
  const v = res.Parameter?.Value;
  if (!v) throw new Error('Gemini API key parameter empty');
  cachedApiKey = v;
  return v;
}

function response(statusCode: number, body: any) {
  return { statusCode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
}

export const handler: APIGatewayProxyHandlerV2 = async (event) => {
  try {
    if (!event.body) return response(400, { error: { code: 'BadRequest', message: 'Missing body' }, data: null, meta: { requestTimeoutMs: REQUEST_TIMEOUT_MS } });
    let imageBase64: string | undefined;
    try {
      const parsed = JSON.parse(event.body);
      imageBase64 = parsed.imageBase64;
    } catch {
      return response(400, { error: { code: 'BadJSON', message: 'Body must be JSON' }, data: null, meta: null });
    }
    if (!imageBase64 || typeof imageBase64 !== 'string') return response(400, { error: { code: 'BadRequest', message: 'imageBase64 required' }, data: null, meta: null });
    // Strip possible data URI prefix
    const cleaned = imageBase64.replace(/^data:image\/[a-zA-Z0-9+.-]+;base64,/, '');
    if (cleaned.length > MAX_IMAGE_BASE64_LENGTH) {
      return response(413, { error: { code: 'ImageTooLarge', message: `Image base64 length ${cleaned.length} exceeds limit ${MAX_IMAGE_BASE64_LENGTH}` }, data: null, meta: { max: MAX_IMAGE_BASE64_LENGTH } });
    }
    console.log('ExtractTrades start', { sizeChars: cleaned.length, requestTimeoutMs: REQUEST_TIMEOUT_MS });
    const started = Date.now();
    let apiKey: string;
    try {
      apiKey = await getApiKey();
    } catch (e: any) {
      return response(500, { error: { code: 'ConfigError', message: e.message }, data: null, meta: null });
    }
    const genAI = new GoogleGenerativeAI(apiKey);
    const model = genAI.getGenerativeModel({ model: MODEL_ID }, { timeout: REQUEST_TIMEOUT_MS });
    let text: string;
    try {
      console.log('Calling Gemini model', { model: MODEL_ID });
      const result = await model.generateContent([
        GEMINI_VISION_PROMPT,
        { inlineData: { data: cleaned, mimeType: 'image/png' } }
      ]);
      text = result.response.text().trim();
    } catch (err: any) {
      const elapsed = Date.now() - started;
      const isAbort = err?.name === 'AbortError' || /aborted/i.test(err?.message || '');
      console.error('Gemini call failed', { elapsedMs: elapsed, isAbort, error: err?.message });
      if (isAbort) {
        return response(504, { error: { code: 'UpstreamTimeout', message: `Gemini request exceeded ${REQUEST_TIMEOUT_MS}ms` }, data: null, meta: { elapsedMs: elapsed } });
      }
      return response(502, { error: { code: 'UpstreamError', message: err?.message || 'Gemini error' }, data: null, meta: { elapsedMs: elapsed } });
    }
    const elapsed = Date.now() - started;
    console.log('Gemini response received', { elapsedMs: elapsed, chars: text.length });

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

    const extracted = extractJsonArray(text);
    if (!extracted.json) {
      return response(500, { error: { code: 'ParseError', message: 'Model did not return JSON array', raw: text.slice(0, 2000) }, data: null, meta: { elapsedMs: elapsed, parseSteps: extracted.steps } });
    }
    let items: any[];
    try {
      items = JSON.parse(extracted.json);
    } catch (e: any) {
      return response(500, { error: { code: 'JSONParseError', message: e.message }, data: null, meta: { elapsedMs: elapsed, parseSteps: extracted.steps } });
    }
    return response(200, { data: { items }, meta: { elapsedMs: elapsed, parseSteps: extracted.steps }, error: null });
  } catch (e: any) {
    console.error('ExtractTrades error', e);
    return response(500, { error: { code: 'InternalError', message: e?.message || 'Unexpected error' }, data: null, meta: null });
  }
};
