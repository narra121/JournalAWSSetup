import type { ApiHandler } from '../../shared/types';
import { envelope, errorFromException, errorResponse, ErrorCodes } from '../../shared/validation';
import { getUserId } from '../../shared/auth';
import { generateText, geminiTimeoutMs, type GeminiPart } from '../../shared/gemini';
import { getUserTimeZone } from '../../shared/timezone';
import { decideOrder, isTimeZone, readCell, resolveCell, type DateOrder, type DateOrderSource, type ReadContext } from './dates';

const OUTPUT_HEADER = 'symbol,side,quantity,openTime,closeTime,entryPrice,exitPrice,stopLoss,takeProfit,pnl';

const DATE_RULES = `DATE AND TIME CELLS (CRITICAL — the app reads them in code):
- Copy every date/time cell EXACTLY as it is written, character for character: same digit order, separators, year, seconds, milliseconds, AM/PM and zone. Examples: \`03/12/2025 08:41:09.075\`, \`12/3/25 8:41 PM\`, \`2025.12.03 08:41\`, \`Dec 3, 2025 20:41:09\`, \`17:01\`.
- NEVER reorder day and month, NEVER convert to ISO, NEVER add a missing year, date or seconds. Quote the cell if it contains a comma.
- openTime = the column for when the position was opened (Open time, Opening time, Entry time, Open date, Time opened). closeTime = when it was closed (Close time, Closing time, Exit time, Close date).
- Only a column whose cells are dates/times is a time column. A side column such as "Opening direction" is NOT an open time.
- If the table has only ONE date/time column and its header does not say open/entry, it is the close time: put it in closeTime and leave openTime empty.
- If the table has only an open column, leave closeTime empty. Never copy one column into the other.
- If date and time sit in two separate columns for the same moment, join them with one space: \`<date> <time>\`.
- If one cell shows two date-times (open above close), put the first in openTime and the second in closeTime.

FIRST LINE (before the CSV header) names the time columns you used, with their header text exactly as shown, or NONE:
TIME_COLUMNS: open=<header or NONE>; close=<header or NONE>`;

const STRICT_OUTPUT = `STRICT OUTPUT RULES:
- Return ONLY: the TIME_COLUMNS line, then the CSV header line, then data lines.
- No other text, explanations, or markdown fences.
- Use this exact header: ${OUTPUT_HEADER}
- Output at most 50 trades. If more exist, output only the first 50.
- If no valid trade rows can be extracted, output the TIME_COLUMNS line and the header line with no data rows.`;

const IMAGE_PROMPT = `ROLE:
You are an expert VISION + OCR financial data extraction model. Your ONLY goal is to read the trade history TABLE shown in the provided image and output it as CSV. You must be completely accurate and not hallucinate any data.

OUTPUT FORMAT (CSV — one header row, then data rows, top-to-bottom as in the table):
${OUTPUT_HEADER}

Each data row contains values in the same column order. Do NOT quote values unless a value contains a comma.

FIELD INTERPRETATION:
- symbol: Instrument ticker exactly as shown (e.g., XAUUSD). Uppercase if clearly uppercase; do NOT invent.
- side: MUST be BUY or SELL (map LONG -> BUY, SHORT -> SELL if those appear; an "Opening direction" column gives the side). If ambiguous, skip the row.
- quantity: Numeric size/lot. If unreadable, skip the row (do not guess). Accept decimals.
- openTime / closeTime: see DATE AND TIME CELLS below.
- entryPrice / exitPrice: Prices as decimals. Strip currency symbols ($, €) and thousands separators (commas or spaces), e.g. 3,344.78 -> 3344.78.
- stopLoss: Stop loss price. If absent or blank, default to 0.
- takeProfit: Take profit price. If absent or blank, default to 0.
- pnl: Profit/Loss value for that row. Preserve sign. Parentheses or a leading minus sign means negative. If colored red and no sign, assume negative.

${DATE_RULES}

MISSING / BLANK HANDLING:
- Required Fields: A valid row must contain \`symbol\`, \`side\` and \`quantity\`. If any of these are unreadable, SKIP the entire row.
- Optional Numeric Fields: If \`entryPrice\`, \`exitPrice\`, \`stopLoss\`, \`takeProfit\`, or \`pnl\` are blank, set them to \`0\`. However, if both \`entryPrice\` and \`exitPrice\` are blank, skip the row as it is likely not a valid trade.

NORMALIZATION & VALIDATION:
- Strip leading/trailing whitespace from all text fields.
- Do not compute or adjust \`pnl\`; use exactly the value displayed in the image.
- If duplicate rows appear, keep them as separate entries unless they are clear visual OCR artifacts of the exact same row.

VISION-SPECIFIC GUIDANCE:
- Pay close attention to column alignment to correctly identify fields.
- Ignore all UI elements like buttons, icons, sort arrows, or checkboxes.
- Ignore columns not present in the target schema (e.g., Status, Order ID, Commission, Fees, Swap, Balance).
- If a currency symbol precedes a price (e.g., $3343.24), drop the symbol.

${STRICT_OUTPUT}`;

const TEXT_PROMPT = `ROLE:
You are an expert financial data normalization model. Your ONLY goal is to parse the provided CSV/tabular trade data and output a precise CSV matching the target format. You must be completely accurate and not hallucinate any data.

OUTPUT FORMAT (CSV — one header row, then data rows):
${OUTPUT_HEADER}

Each data row contains values in the same column order. Do NOT quote values unless a value contains a comma.

COLUMN MAPPING INTELLIGENCE:
You must intelligently map ANY column naming convention to the target schema. Common variations include:
- symbol: Symbol, Ticker, Instrument, Asset, Pair, Market, Product
- side: Side, Direction, Type, Action, Buy/Sell, Long/Short, B/S, Position
- quantity: Quantity, Qty, Size, Lots, Volume, Amount, Contracts, Units
- openTime: Open Date, Entry Date, Open Time, Date Opened, Entry Time, Open
- closeTime: Close Date, Exit Date, Close Time, Date Closed, Exit Time, Close
- entryPrice: Entry Price, Open Price, Entry, Buy Price, Sell Price, Avg Entry
- exitPrice: Exit Price, Close Price, Exit, Avg Exit, Close Avg
- stopLoss: Stop Loss, SL, Stop, S/L
- takeProfit: Take Profit, TP, Target, T/P
- pnl: PnL, P&L, Profit, Profit/Loss, Net P/L, Realized PnL, Net Profit, Gain/Loss, Result

FIELD INTERPRETATION:
- symbol: Instrument ticker as shown. Uppercase. Do NOT invent.
- side: MUST be BUY or SELL. Map: LONG/Long/long -> BUY, SHORT/Short/short -> SELL, Buy/buy -> BUY, Sell/sell -> SELL. If the data uses "Type" with values like "Market Buy" or "Limit Sell", extract Buy/Sell.
- quantity: Numeric size/lot. Accept decimals.
- openTime/closeTime: see DATE AND TIME CELLS below.
- entryPrice/exitPrice: Prices as decimals. Strip currency symbols and thousands separators.
- stopLoss: Default to 0 if absent.
- takeProfit: Default to 0 if absent.
- pnl: Profit/Loss value. Preserve sign. Parentheses mean negative. Strip currency symbols.

${DATE_RULES}

MISSING / BLANK HANDLING:
- Required: symbol, side, quantity. Skip row if any missing.
- If entryPrice AND exitPrice are both blank, skip the row.
- Other numeric fields: default to 0 if blank.

${STRICT_OUTPUT}`;

// Configurable upstream request timeout (ms) for the AI call; default 90000 (90s)
const REQUEST_TIMEOUT_MS = geminiTimeoutMs(90000);
// Hard cap on accepted base64 payload bytes (after stripping data URI) to prevent very large images (default ~3MB)
const MAX_IMAGE_BASE64_LENGTH = (() => {
  const v = parseInt(process.env.MAX_IMAGE_BASE64_LENGTH || '1333334', 10);
  return Number.isFinite(v) && v > 10000 ? v : 1333334;
})();

/** One model call (with fallback to the second model on 429/503); returns the reply text. */
async function callModel(parts: GeminiPart[]): Promise<string> {
  const { text } = await generateText({ parts, maxOutputTokens: 4096, temperature: 0, timeoutMs: REQUEST_TIMEOUT_MS });
  return text;
}

const NOTHING_TO_EXTRACT = 'Add a screenshot or paste some text to extract trades from.';

/** The AI step failed. The cause is logged where it happens, never sent. */
function extractionFailed(isAbort: boolean) {
  return isAbort
    ? errorResponse(500, ErrorCodes.GEMINI_TIMEOUT, 'The extraction took too long. Try again with less data.')
    : errorResponse(500, ErrorCodes.GEMINI_ERROR, "We couldn't read that right now. Please try again in a moment.");
}

/** How the dates of one image (or of the pasted text) were read. Part of the response contract with TradeFlow importApi. */
export interface ImageDates {
  image: number;
  dateOrder: DateOrder;
  dateOrderSource: DateOrderSource;
  canSwitch: boolean;
  /** header text of the time columns the model saw; null = the column is not in the table */
  timeColumns: { open: string | null; close: string | null };
}

export interface ExtractedTrade {
  symbol: string;
  side: string;
  quantity: number;
  /** `YYYY-MM-DDTHH:MM:SS[.fff]`, wall clock of the platform unless the cell carried a zone; '' when unreadable */
  openDate: string;
  closeDate: string;
  entryPrice: number;
  exitPrice: number;
  stopLoss: number;
  takeProfit: number;
  pnl: number;
  image: number;
  /** the cells as the model copied them ('' = blank) */
  openDateRaw: string;
  closeDateRaw: string;
  /** the table has no open (close) time for this row: openDate (closeDate) is a copy of the other one */
  openDateMissing: boolean;
  closeDateMissing: boolean;
  /** the cell had no year (or only a time): the year (date) was filled in */
  yearAssumed: boolean;
  dayAssumed: boolean;
}

export const handler: ApiHandler = async (event) => {
  try {
    const userId = getUserId(event);
    if (!userId) return errorResponse(401, ErrorCodes.UNAUTHORIZED, 'Unauthorized');

    if (!event.body) return errorResponse(400, ErrorCodes.VALIDATION_ERROR, NOTHING_TO_EXTRACT);

    let images: string[] = [];
    let textContent: string | null = null;
    let bodyZone: string | null = null;

    try {
      const parsed = JSON.parse(event.body);
      if (isTimeZone(parsed?.timeZone)) bodyZone = parsed.timeZone;
      if (parsed.textContent && typeof parsed.textContent === 'string') {
        textContent = parsed.textContent;
      } else if (parsed.imageBase64 && typeof parsed.imageBase64 === 'string') {
        images = [parsed.imageBase64];
      } else if (parsed.images && Array.isArray(parsed.images)) {
        if (!parsed.images.every((img: unknown) => typeof img === 'string')) {
          return errorResponse(400, ErrorCodes.VALIDATION_ERROR, 'Each image must be sent as base64 text.');
        }
        images = parsed.images;
      }
    } catch {
      return errorResponse(400, ErrorCodes.VALIDATION_ERROR, 'The request body must be valid JSON.');
    }

    if (!textContent && images.length === 0) {
      return errorResponse(400, ErrorCodes.VALIDATION_ERROR, NOTHING_TO_EXTRACT);
    }

    // The zone the review shows times in (sent by the app), else the saved preference: today's date and the region fallback.
    const ctx: ReadContext = { now: new Date(), timeZone: bodyZone ?? (await getUserTimeZone(userId).catch(() => null)) };

    // --- Text content extraction path ---
    if (textContent) {
      const MAX_TEXT_LENGTH = 10_000;
      if (textContent.length > MAX_TEXT_LENGTH) {
        return errorResponse(400, ErrorCodes.VALIDATION_ERROR, `That text is too long. The limit is ${MAX_TEXT_LENGTH.toLocaleString('en-US')} characters.`);
      }

      const started = Date.now();

      console.log('ExtractTrades processing text content', { chars: textContent.length });

      try {
        const text = await callModel(
          [{ text: TEXT_PROMPT + '\n\nHere is the CSV/tabular trade data to parse:\n\n' + textContent }],
        );

        const reply = parseReply(text);
        const { items, dates } = buildTrades(reply, 0, ctx);
        const parseSteps = reply.steps;
        const elapsed = Date.now() - started;

        if (items.length === 0) {
          // Check if it was a total failure vs just no trades
          const hasData = text.trim().length > 0;
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
          data: { items, images: [dates] },
          meta: { elapsedMs: elapsed, source: 'text', totalExtracted: items.length, parseSteps },
          message: 'Extraction successful'
        });
      } catch (err: any) {
        const elapsed = Date.now() - started;
        const isAbort = err?.name === 'AbortError' || /aborted/i.test(err?.message || '');
        console.error('ExtractTrades AI error', { error: err?.message, isAbort, elapsed });
        return extractionFailed(isAbort);
      }
    }
    // --- End text content path ---

    if (images.length > 3) {
      return errorResponse(400, ErrorCodes.VALIDATION_ERROR, 'You can extract trades from up to 3 images at a time.', { maxImages: 3 });
    }

    const started = Date.now();

    // Process all images concurrently
    const perImage: ExtractedTrade[][] = images.map(() => []);
    const imageDates: (ImageDates | undefined)[] = new Array(images.length);
    const processingDetails: any[] = new Array(images.length);

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

      let text: string;
      try {
        text = await callModel([
          { text: IMAGE_PROMPT },
          { inlineData: { mimeType: detectedMime, data: cleaned } }
        ]);
      } catch (err: any) {
        const isAbort = err?.name === 'AbortError' || /aborted/i.test(err?.message || '');
        console.error(`AI extraction failed for image ${i}`, { isAbort, error: err?.message });

        processingDetails[i] = {
          imageIndex: i,
          error: isAbort ? `Timeout after ${REQUEST_TIMEOUT_MS}ms` : 'AI extraction failed',
          skipped: true
        };

        // Single-image failure: propagate for immediate error response
        if (images.length === 1) {
          throw { _singleImageError: true, isAbort, err };
        }
        return;
      }

      console.log(`AI response received for image ${i}`, { chars: text.length });

      const reply = parseReply(text);
      if (reply.rows.length === 0 && !reply.headerSeen) {
        processingDetails[i] = {
          imageIndex: i,
          error: 'Model did not return parseable CSV or JSON',
          rawPreview: text.slice(0, 200),
          skipped: true
        };
        return;
      }

      const { items, dates } = buildTrades(reply, i, ctx);
      perImage[i] = items;
      imageDates[i] = dates;
      processingDetails[i] = {
        imageIndex: i,
        extractedCount: items.length,
        parseSteps: reply.steps
      };
    }));

    // Handle single-image failure thrown from inside Promise.allSettled
    for (const result of imageResults) {
      if (result.status === 'rejected' && result.reason?._singleImageError) {
        const { isAbort } = result.reason;
        return extractionFailed(isAbort);
      }
    }

    const elapsed = Date.now() - started;
    const finalDetails = processingDetails.filter(Boolean);

    // If all images failed to process, return error
    const allFailed = finalDetails.every(d => d.skipped === true);
    if (allFailed && finalDetails.length > 0) {
      return errorResponse(500, ErrorCodes.EXTRACTION_FAILED, "We couldn't read any of those images. Try again with clearer screenshots.");
    }

    const allItems = perImage.flat();
    return envelope({
      statusCode: 200,
      data: { items: allItems, images: imageDates.filter((d): d is ImageDates => !!d) },
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
    return errorFromException(e);
  }
};

/** One table row as the model wrote it; every value is still text. */
interface RawRow {
  symbol: string;
  side: string;
  quantity: string;
  open: string;
  close: string;
  entryPrice: string;
  exitPrice: string;
  stopLoss: string;
  takeProfit: string;
  pnl: string;
}

interface Reply {
  rows: RawRow[];
  timeColumns: { open: string | null; close: string | null } | null;
  headerSeen: boolean;
  steps: string[];
}

const FIELDS: (keyof RawRow)[] = ['symbol', 'side', 'quantity', 'open', 'close', 'entryPrice', 'exitPrice', 'stopLoss', 'takeProfit', 'pnl'];
const HEADER_ALIASES: Record<string, keyof RawRow> = {
  symbol: 'symbol', side: 'side', quantity: 'quantity',
  opentime: 'open', opendate: 'open', closetime: 'close', closedate: 'close',
  entryprice: 'entryPrice', exitprice: 'exitPrice', stoploss: 'stopLoss', takeprofit: 'takeProfit', pnl: 'pnl',
};

function readTimeColumns(line: string): Reply['timeColumns'] {
  const m = /^\s*TIME_COLUMNS\s*:?\s*open\s*=\s*(.*?)\s*;\s*close\s*=\s*(.*?)\s*$/i.exec(line);
  if (!m) return null;
  const name = (v: string) => {
    const s = v.replace(/^["'`]+|["'`]+$/g, '').trim();
    return !s || /^none$/i.test(s) ? null : s;
  };
  return { open: name(m[1]), close: name(m[2]) };
}

/** The model's reply (CSV with a TIME_COLUMNS line, or a JSON array as a fallback) as raw rows. */
function parseReply(raw: string): Reply {
  const steps: string[] = [];
  let work = raw.trim();
  const fenceMatch = work.match(/```(?:csv|json)?\s*[\r\n]+([\s\S]*?)```/i);
  if (fenceMatch) {
    steps.push('Stripped markdown code fence');
    work = fenceMatch[1].trim();
  }

  const lines = work.split(/\r?\n/).filter((l) => l.trim().length > 0);
  let timeColumns: Reply['timeColumns'] = null;
  let columns: (keyof RawRow | undefined)[] = FIELDS;
  let headerSeen = false;
  const rows: RawRow[] = [];
  for (const [i, line] of lines.entries()) {
    const tc = readTimeColumns(line);
    if (tc) {
      timeColumns = tc;
      continue;
    }
    const cols = parseCSVLine(line);
    const lower = line.toLowerCase();
    if (!headerSeen && lower.includes('symbol') && lower.includes('side')) {
      columns = cols.map((c) => HEADER_ALIASES[c.trim().toLowerCase().replace(/[^a-z]/g, '')]);
      headerSeen = true;
      steps.push('Detected and skipped header row');
      continue;
    }
    if (cols.length < 10) {
      steps.push(`Skipped line ${i + 1}: only ${cols.length} columns`);
      continue;
    }
    const row = Object.fromEntries(FIELDS.map((f) => [f, ''])) as unknown as RawRow;
    cols.forEach((v, c) => {
      const f = columns[c];
      if (f) row[f] = v.trim();
    });
    rows.push(row);
  }

  if (rows.length === 0) {
    const jsonResult = extractJsonArray(work);
    if (jsonResult.json) {
      try {
        const arr = JSON.parse(jsonResult.json);
        if (Array.isArray(arr)) {
          const s = (v: unknown) => (v === null || v === undefined ? '' : String(v));
          for (const o of arr) {
            if (!o || typeof o !== 'object') continue;
            rows.push({
              symbol: s(o.symbol), side: s(o.side), quantity: s(o.quantity),
              open: s(o.openTime ?? o.openDate), close: s(o.closeTime ?? o.closeDate),
              entryPrice: s(o.entryPrice), exitPrice: s(o.exitPrice), stopLoss: s(o.stopLoss), takeProfit: s(o.takeProfit), pnl: s(o.pnl),
            });
          }
          headerSeen = true;
          steps.push('CSV yielded 0 items, fell back to JSON', ...jsonResult.steps);
        }
      } catch {
        steps.push('CSV and JSON both failed');
      }
    }
  }
  steps.push(`Parsed ${rows.length} rows`);
  return { rows, timeColumns, headerSeen, steps };
}

/** A number as written in a table: thousands separators, currency signs and accounting parentheses allowed; 0 when unreadable. */
function num(raw: string): number {
  const t = raw.replace(/[\s,$€£₹¥]/g, '');
  const n = parseFloat(/^\(.*\)$/.test(t) ? `-${t.slice(1, -1)}` : t);
  return Number.isFinite(n) ? n : 0;
}

/** Raw rows of one table → trades, with the day/month order decided across all of the table's date cells. */
function buildTrades(reply: Reply, image: number, ctx: ReadContext): { items: ExtractedTrade[]; dates: ImageDates } {
  let kept = reply.rows.filter((r) => r.symbol && r.side && r.quantity);
  let timeColumns = reply.timeColumns;
  // Open equal to close on every row, to the character, is one time column copied into both (the model does it
  // despite the prompt). It is the close time unless the model reported only an open column.
  if (kept.length > 0 && kept.every((r) => r.open && r.open === r.close)) {
    const openOnly = !!timeColumns?.open && !timeColumns.close;
    kept = kept.map((r) => (openOnly ? { ...r, close: '' } : { ...r, open: '' }));
    timeColumns = openOnly ? { open: timeColumns!.open, close: null } : { open: null, close: timeColumns?.close ?? null };
  }
  const cells = kept.map((r) => ({ open: readCell(r.open), close: readCell(r.close) }));
  const decision = decideOrder(cells, ctx);
  const items = kept.map((r, i): ExtractedTrade => {
    const open = resolveCell(cells[i].open, decision.dateOrder, ctx);
    const close = resolveCell(cells[i].close, decision.dateOrder, ctx);
    return {
      symbol: r.symbol.trim(),
      side: r.side.trim().toUpperCase(),
      quantity: num(r.quantity),
      openDate: open?.iso ?? close?.iso ?? '',
      closeDate: close?.iso ?? open?.iso ?? '',
      entryPrice: num(r.entryPrice),
      exitPrice: num(r.exitPrice),
      stopLoss: num(r.stopLoss),
      takeProfit: num(r.takeProfit),
      pnl: num(r.pnl),
      image,
      openDateRaw: r.open,
      closeDateRaw: r.close,
      openDateMissing: !open && !!close,
      closeDateMissing: !close && !!open,
      yearAssumed: !!(open?.yearAssumed || close?.yearAssumed),
      dayAssumed: !!(open?.dayAssumed || close?.dayAssumed),
    };
  });
  const seen = (pick: (r: RawRow) => string) => kept.some((r) => readCell(pick(r)));
  const columns = {
    open: seen((r) => r.open) ? (timeColumns?.open ?? 'Open time') : null,
    close: seen((r) => r.close) ? (timeColumns?.close ?? 'Close time') : null,
  };
  return { items, dates: { image, ...decision, timeColumns: columns } };
}

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
