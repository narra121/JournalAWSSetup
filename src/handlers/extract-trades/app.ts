import { APIGatewayProxyHandlerV2 } from 'aws-lambda';
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';
import { envelope, errorResponse, ErrorCodes } from '../../shared/validation';
import { getUserId } from '../../shared/auth';
import { checkSubscription } from '../../shared/subscription';

const MODELS = ['gemini-2.5-flash-lite', 'gemini-2.5-flash'];
const GEMINI_API_BASE = 'https://generativelanguage.googleapis.com/v1beta';
const RETRYABLE_STATUS_CODES = [429, 503];


const buildGeminiPrompt = () => {
  const now = new Date();
  const year = now.getUTCFullYear();
  const month = String(now.getUTCMonth() + 1).padStart(2, '0');
  const day = String(now.getUTCDate()).padStart(2, '0');
  const monthNames = ['January','February','March','April','May','June','July','August','September','October','November','December'];
  const monthName = monthNames[now.getUTCMonth()];

  return `ROLE:
You are an expert VISION + OCR financial data extraction model. Your ONLY goal is to read the trade history TABLE shown in the provided image and output a precise structured JSON array. You must be completely accurate and not hallucinate any data.

OUTPUT FORMAT (CSV — one header row, then data rows, top-to-bottom as in the table):
symbol,side,quantity,openDate,closeDate,entryPrice,exitPrice,stopLoss,takeProfit,pnl

Each data row contains values in the same column order. Do NOT quote values unless a value contains a comma.


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
For this task, the current date is ${monthName} ${parseInt(day)}, ${year}. Use these components to complete any missing date information:
- CurrentYear: \`${year}\`
- CurrentMonth: \`${month}\`
- CurrentDay: \`${day}\`

1. Full Datetime Provided: If a cell has a full datetime with a 4-digit year (e.g., \`2024-12-15 17:18\`), use it exactly as provided, even if the year is not ${year}.
2. Year is Missing: If a cell has a month and day but no year (e.g., \`${month}-20 17:18\`), complete it using \`CurrentYear\`. Result: \`${year}-${month}-20T17:18:00\`.
3. Year and Month are Missing: If a cell has only a time (e.g., \`17:01\`), complete it using \`CurrentYear\`, \`CurrentMonth\`, and \`CurrentDay\`. Result: \`${year}-${month}-${day}T17:01:00\`.
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
- Return ONLY CSV text: one header line followed by data lines.
- No leading/trailing text, explanations, or markdown fences.
- Use this exact header: symbol,side,quantity,openDate,closeDate,entryPrice,exitPrice,stopLoss,takeProfit,pnl
- Output at most 50 trades. If more exist, output only the first 50.
- If no valid trade rows can be extracted, output ONLY the header line with no data rows.`;
};

const buildTextExtractionPrompt = () => {
  // Same date vars as buildGeminiPrompt
  const now = new Date();
  const year = now.getUTCFullYear();
  const month = String(now.getUTCMonth() + 1).padStart(2, '0');
  const day = String(now.getUTCDate()).padStart(2, '0');
  const monthNames = ['January','February','March','April','May','June','July','August','September','October','November','December'];
  const monthName = monthNames[now.getUTCMonth()];

  return `ROLE:
You are an expert financial data normalization model. Your ONLY goal is to parse the provided CSV/tabular trade data and output a precise CSV matching the target format. You must be completely accurate and not hallucinate any data.

OUTPUT FORMAT (CSV — one header row, then data rows):
symbol,side,quantity,openDate,closeDate,entryPrice,exitPrice,stopLoss,takeProfit,pnl

Each data row contains values in the same column order. Do NOT quote values unless a value contains a comma.

COLUMN MAPPING INTELLIGENCE:
You must intelligently map ANY column naming convention to the target schema. Common variations include:
- symbol: Symbol, Ticker, Instrument, Asset, Pair, Market, Product
- side: Side, Direction, Type, Action, Buy/Sell, Long/Short, B/S, Position
- quantity: Quantity, Qty, Size, Lots, Volume, Amount, Contracts, Units
- openDate: Open Date, Entry Date, Open Time, Date Opened, Entry Time, Open, Date
- closeDate: Close Date, Exit Date, Close Time, Date Closed, Exit Time, Close
- entryPrice: Entry Price, Open Price, Entry, Buy Price, Sell Price, Avg Entry
- exitPrice: Exit Price, Close Price, Exit, Avg Exit, Close Avg
- stopLoss: Stop Loss, SL, Stop, S/L
- takeProfit: Take Profit, TP, Target, T/P
- pnl: PnL, P&L, Profit, Profit/Loss, Net P/L, Realized PnL, Net Profit, Gain/Loss, Result

FIELD INTERPRETATION:
- symbol: Instrument ticker as shown. Uppercase. Do NOT invent.
- side: MUST be BUY or SELL. Map: LONG/Long/long -> BUY, SHORT/Short/short -> SELL, Buy/buy -> BUY, Sell/sell -> SELL. If the data uses "Type" with values like "Market Buy" or "Limit Sell", extract Buy/Sell.
- quantity: Numeric size/lot. Accept decimals.
- openDate/closeDate: See DATE COMPLETION ALGORITHM below.
- entryPrice/exitPrice: Prices as decimals. Strip currency symbols and commas.
- stopLoss: Default to 0 if absent.
- takeProfit: Default to 0 if absent.
- pnl: Profit/Loss value. Preserve sign. Parentheses mean negative. Strip currency symbols.

DATE COMPLETION ALGORITHM:
Current date: ${monthName} ${parseInt(day)}, ${year}.
1. Full date with year: use exactly as provided.
2. Date without year: add ${year}.
3. Date without time: add T00:00:00.
4. Always output ISO 8601: YYYY-MM-DDTHH:MM:SS.
5. Blank close date: copy from open date.

MISSING / BLANK HANDLING:
- Required: symbol, side, quantity, openDate. Skip row if any missing.
- If entryPrice AND exitPrice are both blank, skip the row.
- Other numeric fields: default to 0 if blank.

STRICT OUTPUT RULES:
- Return ONLY CSV text: one header line followed by data lines.
- No leading/trailing text, explanations, or markdown fences.
- Use this exact header: symbol,side,quantity,openDate,closeDate,entryPrice,exitPrice,stopLoss,takeProfit,pnl
- Output at most 50 trades. If more exist, output only the first 50.
- If no valid rows, output ONLY the header line with no data rows.`;
};

// Configurable upstream request timeout (ms) for Gemini fetch; default 90000 (90s)
const REQUEST_TIMEOUT_MS = (() => {
  const v = parseInt(process.env.GEMINI_REQUEST_TIMEOUT_MS || '90000', 10);
  return Number.isFinite(v) && v > 0 ? v : 90000;
})();
// Hard cap on accepted base64 payload bytes (after stripping data URI) to prevent very large images (default ~3MB)
const MAX_IMAGE_BASE64_LENGTH = (() => {
  const v = parseInt(process.env.MAX_IMAGE_BASE64_LENGTH || '1333334', 10);
  return Number.isFinite(v) && v > 10000 ? v : 1333334;
})();

// --- Prompt caching (TTL-based, avoids rebuilding date strings on every invocation) ---
let cachedGeminiPrompt: { text: string; expiry: number; dateKey: string } | null = null;
let cachedTextPrompt: { text: string; expiry: number; dateKey: string } | null = null;
const PROMPT_CACHE_TTL = 3600000; // 1 hour

function getGeminiPrompt(): string {
  const now = Date.now();
  const todayKey = new Date().toISOString().slice(0, 10);
  if (!cachedGeminiPrompt || now > cachedGeminiPrompt.expiry || cachedGeminiPrompt.dateKey !== todayKey) {
    cachedGeminiPrompt = { text: buildGeminiPrompt(), expiry: now + PROMPT_CACHE_TTL, dateKey: todayKey };
  }
  return cachedGeminiPrompt.text;
}

function getTextPrompt(): string {
  const now = Date.now();
  const todayKey = new Date().toISOString().slice(0, 10);
  if (!cachedTextPrompt || now > cachedTextPrompt.expiry || cachedTextPrompt.dateKey !== todayKey) {
    cachedTextPrompt = { text: buildTextExtractionPrompt(), expiry: now + PROMPT_CACHE_TTL, dateKey: todayKey };
  }
  return cachedTextPrompt.text;
}

// --- API key caching with TTL ---
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

/** Call Gemini API with automatic fallback to secondary model on 429/503. */
async function callGemini(
  apiKey: string,
  parts: Array<{ text: string } | { inlineData: { mimeType: string; data: string } }>,
  signal: AbortSignal
): Promise<string> {
  for (let i = 0; i < MODELS.length; i++) {
    const model = MODELS[i];
    const isLast = i === MODELS.length - 1;
    const url = `${GEMINI_API_BASE}/models/${model}:generateContent`;

    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
      body: JSON.stringify({
        contents: [{ role: 'user', parts }],
        generationConfig: { temperature: 0, maxOutputTokens: 4096, thinkingConfig: { thinkingBudget: 0 } },
      }),
      signal,
    });

    if (!resp.ok) {
      const errorText = await resp.text();
      if (!isLast && RETRYABLE_STATUS_CODES.includes(resp.status)) {
        console.warn(`Gemini ${model} returned ${resp.status}, falling back to ${MODELS[i + 1]}`);
        continue;
      }
      throw new Error(`Gemini API error: ${resp.status} ${resp.statusText} - ${errorText}`);
    }

    const data = await resp.json();
    const responseParts = data.candidates?.[0]?.content?.parts || [];
    const text = responseParts.filter((p: any) => p.text).pop()?.text;
    if (!text) throw new Error('Gemini returned empty response');
    if (i > 0) console.log(`Used fallback model ${model} successfully`);
    return text.trim();
  }

  throw new Error('All Gemini models failed');
}

export const handler: APIGatewayProxyHandlerV2 = async (event) => {
  try {
    const userId = getUserId(event);
    if (!userId) return errorResponse(401, ErrorCodes.UNAUTHORIZED, 'Unauthorized');

    const subError = await checkSubscription(userId);
    if (subError) return subError;

    if (!event.body) return envelope({ statusCode: 400, error: { code: 'BadRequest', message: 'Missing body' }, meta: { requestTimeoutMs: REQUEST_TIMEOUT_MS }, message: 'Missing body' });
    
    let images: string[] = [];
    let textContent: string | null = null;

    try {
      const parsed = JSON.parse(event.body);
      if (parsed.textContent && typeof parsed.textContent === 'string') {
        textContent = parsed.textContent;
      } else if (parsed.imageBase64 && typeof parsed.imageBase64 === 'string') {
        images = [parsed.imageBase64];
      } else if (parsed.images && Array.isArray(parsed.images)) {
        images = parsed.images;
      }
    } catch {
      return envelope({ statusCode: 400, error: { code: 'BadJSON', message: 'Body must be JSON' }, message: 'Body must be JSON' });
    }

    if (!textContent && images.length === 0) {
      return envelope({ statusCode: 400, error: { code: 'BadRequest', message: 'imageBase64, images array, or textContent required' }, message: 'imageBase64, images array, or textContent required' });
    }
    
    // --- Text content extraction path ---
    if (textContent) {
      const MAX_TEXT_LENGTH = 10_000;
      if (textContent.length > MAX_TEXT_LENGTH) {
        return envelope({ statusCode: 400, error: { code: 'BadRequest', message: `Text content exceeds ${MAX_TEXT_LENGTH} character limit` }, message: 'Text content too large' });
      }

      const started = Date.now();
      let apiKey: string;
      try { apiKey = await getApiKey(); } catch (e: any) {
        return envelope({ statusCode: 500, error: { code: 'ConfigError', message: e.message }, message: e.message });
      }

      console.log('ExtractTrades processing text content', { chars: textContent.length });

      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

        const text = await callGemini(
          apiKey,
          [{ text: getTextPrompt() + '\n\nHere is the CSV/tabular trade data to parse:\n\n' + textContent }],
          controller.signal
        );

        clearTimeout(timeoutId);

        // Try CSV first, fall back to JSON
        const csvResult = parseCSVResponse(text);
        let items: any[];
        let parseSteps: string[];

        if (csvResult.items.length > 0) {
          items = csvResult.items;
          parseSteps = csvResult.steps;
        } else {
          const jsonResult = extractJsonArray(text);
          if (jsonResult.json) {
            try {
              items = JSON.parse(jsonResult.json);
              parseSteps = [...csvResult.steps, 'CSV yielded 0 items, fell back to JSON', ...jsonResult.steps];
            } catch {
              items = [];
              parseSteps = [...csvResult.steps, 'CSV and JSON both failed'];
            }
          } else {
            items = [];
            parseSteps = [...csvResult.steps, 'No CSV or JSON data found'];
          }
        }

        const elapsed = Date.now() - started;

        if (items.length === 0) {
          // Check if it was a total failure vs just no trades
          const hasData = csvResult.items.length > 0 || text.trim().length > 0;
          return envelope({
            statusCode: 200,
            data: { items: [] },
            error: {
              code: hasData ? 'NoTradesFound' : 'ExtractionFailed',
              message: hasData
                ? 'The data was processed but no valid trade rows were found. Check that your data includes required fields: Symbol, Side (Buy/Sell), Quantity, and Date.'
                : 'Could not extract any trade data from the provided content. Ensure it contains structured trade information with columns like Symbol, Side, Price, Date, etc.'
            },
            meta: { elapsedMs: elapsed, source: 'text', rawPreview: text.slice(0, 300), parseSteps },
            message: 'No trades could be extracted from the provided data'
          });
        }

        return envelope({
          statusCode: 200,
          data: { items },
          meta: { elapsedMs: elapsed, source: 'text', totalExtracted: items.length, parseSteps },
          message: 'Extraction successful'
        });
      } catch (err: any) {
        const elapsed = Date.now() - started;
        const isAbort = err?.name === 'AbortError' || /aborted/i.test(err?.message || '');
        console.error('ExtractTrades Gemini error', { error: err?.message, isAbort, elapsed });
        return envelope({
          statusCode: 500,
          error: {
            code: isAbort ? 'GeminiTimeout' : 'GeminiError',
            message: isAbort ? `Request timed out after ${REQUEST_TIMEOUT_MS / 1000}s. Try with less data.` : (err?.message || 'AI processing failed')
          },
          meta: { elapsedMs: elapsed },
          message: 'Extraction failed'
        });
      }
    }
    // --- End text content path ---

    if (images.length > 3) {
      return envelope({ statusCode: 400, error: { code: 'BadRequest', message: 'Maximum 3 images allowed' }, meta: { maxImages: 3 }, message: 'Maximum 3 images allowed' });
    }

    const started = Date.now();
    let apiKey: string;
    try {
      apiKey = await getApiKey();
    } catch (e: any) {
      return envelope({ statusCode: 500, error: { code: 'ConfigError', message: e.message }, message: e.message });
    }

    // Process all images concurrently via Gemini direct API
    const allItems: any[] = [];
    const processingDetails: any[] = new Array(images.length);
    const prompt = getGeminiPrompt();

    const imageResults = await Promise.allSettled(images.map(async (imageBase64, i) => {
      // Detect MIME type from data URI prefix before stripping it
      const mimeMatch = /^data:(image\/[a-zA-Z0-9+.-]+);base64,/i.exec(imageBase64);
      const detectedMime = mimeMatch ? mimeMatch[1] : 'image/png';
      const cleaned = imageBase64.replace(/^data:image\/[a-zA-Z0-9+.-]+;base64,/i, '');

      if (cleaned.length > MAX_IMAGE_BASE64_LENGTH) {
        processingDetails[i] = {
          imageIndex: i,
          error: `Image base64 length ${cleaned.length} exceeds limit ${MAX_IMAGE_BASE64_LENGTH}`,
          skipped: true
        };
        return;
      }

      console.log(`ExtractTrades processing image ${i + 1}/${images.length}`, { sizeChars: cleaned.length });

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

      let text: string;
      try {
        text = await callGemini(
          apiKey,
          [
            { text: prompt },
            { inlineData: { mimeType: detectedMime, data: cleaned } }
          ],
          controller.signal
        );
        clearTimeout(timeoutId);
      } catch (err: any) {
        clearTimeout(timeoutId);
        const isAbort = err?.name === 'AbortError' || /aborted/i.test(err?.message || '');
        console.error(`Gemini API call failed for image ${i}`, { isAbort, error: err?.message });

        processingDetails[i] = {
          imageIndex: i,
          error: isAbort ? `Timeout after ${REQUEST_TIMEOUT_MS}ms` : err?.message || 'Gemini API call failed',
          skipped: true
        };

        // Single-image failure: propagate for immediate error response
        if (images.length === 1) {
          throw { _singleImageError: true, isAbort, err };
        }
        return;
      }

      console.log(`Gemini response received for image ${i}`, { chars: text.length });

      // Try CSV first, fall back to JSON
      const csvResult = parseCSVResponse(text);
      let items: any[];
      let parseSteps: string[];

      if (csvResult.items.length > 0) {
        items = csvResult.items;
        parseSteps = csvResult.steps;
      } else {
        const jsonResult = extractJsonArray(text);
        if (jsonResult.json) {
          try {
            items = JSON.parse(jsonResult.json);
            parseSteps = [...csvResult.steps, 'CSV yielded 0 items, fell back to JSON', ...jsonResult.steps];
          } catch (e: any) {
            processingDetails[i] = {
              imageIndex: i,
              error: `Parse error: ${e.message}`,
              skipped: true
            };
            return;
          }
        } else {
          processingDetails[i] = {
            imageIndex: i,
            error: 'Model did not return parseable CSV or JSON',
            rawPreview: text.slice(0, 200),
            skipped: true
          };
          return;
        }
      }

      allItems.push(...items);
      processingDetails[i] = {
        imageIndex: i,
        extractedCount: items.length,
        parseSteps
      };
    }));

    // Handle single-image failure thrown from inside Promise.allSettled
    for (const result of imageResults) {
      if (result.status === 'rejected' && result.reason?._singleImageError) {
        const { isAbort, err } = result.reason;
        const imageElapsed = Date.now() - started;
        return envelope({
          statusCode: 500,
          error: {
            code: isAbort ? 'GeminiTimeout' : 'GeminiError',
            message: isAbort ? `Request timeout after ${REQUEST_TIMEOUT_MS}ms` : (err?.message || 'Gemini API call failed')
          },
          meta: { elapsedMs: imageElapsed },
          message: 'Extraction failed'
        });
      }
    }

    const elapsed = Date.now() - started;
    const finalDetails = processingDetails.filter(Boolean);

    // If all images failed to process, return error
    const allFailed = finalDetails.every(d => d.skipped === true);
    if (allFailed && finalDetails.length > 0) {
      return envelope({
        statusCode: 500,
        error: {
          code: 'ExtractionFailed',
          message: 'All images failed to process',
          details: finalDetails
        },
        meta: { elapsedMs: elapsed, totalImages: images.length },
        message: 'All images failed to process'
      });
    }

    return envelope({
      statusCode: 200,
      data: { items: allItems },
      meta: {
        elapsedMs: elapsed,
        totalImages: images.length,
        totalExtracted: allItems.length,
        processingDetails: finalDetails
      },
      message: 'Extraction successful'
    });
  } catch (e: any) {
    console.error('ExtractTrades error', e);
    return envelope({ statusCode: 500, error: { code: 'InternalError', message: e?.message || 'Unexpected error' }, message: 'Internal error' });
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

function parseCSVResponse(raw: string): { items: any[]; steps: string[] } {
  const steps: string[] = [];
  let work = raw.trim();

  const fenceMatch = work.match(/```(?:csv)?\s*[\r\n]+([\s\S]*?)```/i);
  if (fenceMatch) {
    steps.push('Stripped markdown code fence');
    work = fenceMatch[1].trim();
  }

  const lines = work.split(/\r?\n/).filter(l => l.trim().length > 0);
  if (lines.length === 0) {
    steps.push('Empty response');
    return { items: [], steps };
  }

  let startIndex = 0;
  const firstLineLower = lines[0].toLowerCase();
  if (firstLineLower.includes('symbol') && firstLineLower.includes('side')) {
    steps.push('Detected and skipped header row');
    startIndex = 1;
  }

  const items: any[] = [];
  for (let i = startIndex; i < lines.length; i++) {
    const cols = parseCSVLine(lines[i]);
    if (cols.length < 10) {
      steps.push(`Skipped line ${i + 1}: only ${cols.length} columns`);
      continue;
    }

    const [symbol, side, quantity, openDate, closeDate, entryPrice, exitPrice, stopLoss, takeProfit, pnl] = cols;

    if (!symbol || !side || !quantity || !openDate) {
      steps.push(`Skipped line ${i + 1}: missing required field`);
      continue;
    }

    items.push({
      symbol: symbol.trim(),
      side: side.trim().toUpperCase(),
      quantity: parseFloat(quantity) || 0,
      openDate: openDate.trim(),
      closeDate: (closeDate || openDate).trim(),
      entryPrice: parseFloat(entryPrice) || 0,
      exitPrice: parseFloat(exitPrice) || 0,
      stopLoss: parseFloat(stopLoss) || 0,
      takeProfit: parseFloat(takeProfit) || 0,
      pnl: parseFloat(pnl) || 0,
    });
  }

  steps.push(`Parsed ${items.length} trades from CSV`);
  return { items, steps };
}

function parseCSVLine(line: string): string[] {
  const result: string[] = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (i + 1 < line.length && line[i + 1] === '"') {
          current += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        current += ch;
      }
    } else {
      if (ch === '"') {
        inQuotes = true;
      } else if (ch === ',') {
        result.push(current);
        current = '';
      } else {
        current += ch;
      }
    }
  }
  result.push(current);
  return result;
}
