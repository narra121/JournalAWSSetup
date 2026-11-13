/**
 * The one body every non-2xx API response carries (README "API"):
 * `{ success:false, message, errorCode, errorMessage, error?, requestId? }`.
 * - `message` is plain text for a trader and is shown as is; `errorMessage` always equals it (older clients).
 * - `errorCode` is UPPER_SNAKE_CASE and stable; `error.code` repeats it.
 * - `error` holds every machine-readable extra: `retryAfter` (seconds, 429), `fields` (validation), plan/quota data (402).
 */
export interface FieldError {
  field: string;
  message: string;
}

export type ErrorDetails = { retryAfter?: number; fields?: FieldError[] } & Record<string, unknown>;

export interface ApiErrorBody {
  success: false;
  message: string;
  errorCode: string;
  errorMessage: string;
  error?: { code: string } & ErrorDetails;
  requestId?: string;
}

const UNAVAILABLE = 'The service is temporarily unavailable. Please try again in a moment.';

/** What a status means when the producer did not say: code and a sentence a trader can read. */
const STATUS_DEFAULTS: Record<number, { code: string; message: string }> = {
  400: { code: 'VALIDATION_ERROR', message: "That request wasn't valid. Check it and try again." },
  401: { code: 'UNAUTHORIZED', message: 'Your session has ended. Please log in again.' },
  402: { code: 'PLAN_REQUIRED', message: 'This needs a paid plan.' },
  403: { code: 'FORBIDDEN', message: "You don't have permission to do that." },
  404: { code: 'NOT_FOUND', message: "We couldn't find what you asked for." },
  405: { code: 'METHOD_NOT_ALLOWED', message: "That action isn't supported." },
  409: { code: 'CONFLICT', message: 'That conflicts with the current state. Refresh and try again.' },
  413: { code: 'PAYLOAD_TOO_LARGE', message: 'That request is too large.' },
  422: { code: 'UNPROCESSABLE', message: "We couldn't process that request." },
  429: { code: 'RATE_LIMITED', message: 'Too many requests. Please wait a moment and try again.' },
  500: { code: 'INTERNAL_ERROR', message: 'Something went wrong on our side. Please try again.' },
  502: { code: 'BAD_GATEWAY', message: UNAVAILABLE },
  503: { code: 'SERVICE_UNAVAILABLE', message: UNAVAILABLE },
  504: { code: 'GATEWAY_TIMEOUT', message: UNAVAILABLE },
};

export function defaultsFor(status: number): { code: string; message: string } {
  return STATUS_DEFAULTS[status] ?? (status >= 500 ? STATUS_DEFAULTS[500] : STATUS_DEFAULTS[400]);
}

/** One-word messages ("Not found", "Internal error") say nothing to a trader; the status sentence replaces them. */
export function plainMessage(status: number, message: string | undefined): string | undefined {
  return message && /^(unauthorized|forbidden|not found|bad request|(internal )?(server )?error|failed)\.?$/i.test(message.trim()) ? defaultsFor(status).message : message;
}

/** `BadRequest` / `bad-request` / `bad request` -> `BAD_REQUEST`; anything else is returned upper-cased. */
export function toErrorCode(code: string): string {
  return code
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[^A-Za-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toUpperCase();
}

/** First field message, plus how many more there are, so the one sentence a trader sees says what to fix. */
function summarizeFields(fields: FieldError[]): string {
  const more = fields.length - 1;
  return more > 0 ? `${fields[0].message} (and ${more} more)` : fields[0].message;
}

/** `details` is either the extras object or a plain list of field errors. */
export function errorBody(code: string, message: string, details: ErrorDetails | FieldError[] = {}, requestId?: string): ApiErrorBody {
  const extras: ErrorDetails = Array.isArray(details) ? { fields: details } : { ...details };
  if (!extras.fields?.length) delete extras.fields;
  if (typeof extras.retryAfter !== 'number') delete extras.retryAfter;
  const errorCode = toErrorCode(code) || 'ERROR';
  const text = extras.fields ? summarizeFields(extras.fields) : message?.trim() || 'Something went wrong. Please try again.';
  return {
    success: false,
    message: text,
    errorCode,
    errorMessage: text,
    ...(Object.keys(extras).length ? { error: { code: errorCode, ...extras } } : {}),
    ...(requestId ? { requestId } : {}),
  };
}

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const firstString = (...values: unknown[]): string | undefined => values.find((v): v is string => typeof v === 'string' && v.trim() !== '');

/**
 * Turns whatever a producer put in a >= 400 response (the contract itself, `{ error: 'text' }`, `{ message }`,
 * `{ data, error: { code, message, details }, meta }`, the old `errors[]` list, plain text, nothing) into the contract.
 * Plain text is never passed through: it is an AWS error page or a stack trace, not something to show a trader.
 */
export function normalizeErrorBody(status: number, text: string | undefined): ApiErrorBody {
  const fallback = defaultsFor(status);
  let parsed: unknown;
  try {
    parsed = text ? JSON.parse(text) : undefined;
  } catch {
    parsed = undefined;
  }
  if (!isRecord(parsed)) return errorBody(fallback.code, fallback.message);

  const nested = isRecord(parsed.error) ? parsed.error : {};
  const { code: _code, message: _message, details, ...rest } = nested;
  const extras: ErrorDetails = { ...rest, ...(isRecord(details) ? details : {}) };
  if (!extras.fields && Array.isArray(details)) extras.fields = details as FieldError[];

  if (Array.isArray(parsed.errors)) {
    for (const item of parsed.errors) {
      if (!isRecord(item)) continue;
      if (typeof item.retryAfter === 'number') extras.retryAfter ??= item.retryAfter;
      else if (typeof item.field === 'string' && typeof item.message === 'string') (extras.fields ??= []).push({ field: item.field, message: item.message });
    }
  }

  const code = firstString(parsed.errorCode, nested.code, parsed.code) ?? fallback.code;
  const message =
    plainMessage(status, firstString(parsed.message, parsed.errorMessage, nested.message, typeof parsed.error === 'string' ? parsed.error : undefined)) ?? fallback.message;
  const requestId = typeof parsed.requestId === 'string' ? parsed.requestId : undefined;
  return errorBody(code, message, extras, requestId);
}
