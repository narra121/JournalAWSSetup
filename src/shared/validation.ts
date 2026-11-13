import Ajv, { ErrorObject } from 'ajv';
import addFormats from 'ajv-formats';
import { defaultsFor, errorBody, plainMessage, type ErrorDetails, type FieldError } from './apiError';

const ajv = new Ajv({ allErrors: true, removeAdditional: true, useDefaults: true });
addFormats(ajv);

const schemaCache: Record<string, any> = {};

export function getValidator(schema: object, key: string) {
  if (!schemaCache[key]) {
    schemaCache[key] = ajv.compile(schema as any);
  }
  return schemaCache[key];
}

export interface ValidationResult { valid: boolean; errors?: FieldError[] }

const words = (s: string) => s.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[_-]+/g, ' ').toLowerCase();
const singular = (s: string) => (s.endsWith('s') ? s.slice(0, -1) : s);
const isIndex = (s: string | undefined) => s !== undefined && /^\d+$/.test(s);
const TYPE_TEXT: Record<string, string> = { string: 'text', number: 'a number', integer: 'a whole number', boolean: 'true or false', array: 'a list', object: 'an object' };

/** `/images/3/timeframe` -> "image 4 timeframe", `/entryPrice` -> "entry price". */
function fieldLabel(path: string[]): string {
  const last = path[path.length - 1];
  if (last === undefined) return 'the request';
  if (isIndex(last)) return `${words(singular(path[path.length - 2] ?? 'item'))} ${Number(last) + 1}`;
  const parent = path[path.length - 2];
  const owner = path[path.length - 3];
  if (isIndex(parent) && owner) return `${words(singular(owner))} ${Number(parent) + 1} ${words(last)}`;
  return words(last);
}

/** One ajv error as a sentence a trader can act on ("Entry price must be a number"). */
function describeError(e: ErrorObject): FieldError {
  const path = e.instancePath.split('/').filter(Boolean).map((s) => s.replace(/~1/g, '/').replace(/~0/g, '~'));
  if (e.keyword === 'required') path.push(String((e.params as any).missingProperty));
  const p = e.params as Record<string, any>;
  const plural = (n: number) => (n === 1 ? '1 item' : `${n} items`);
  const phrase = ((): string => {
    switch (e.keyword) {
      case 'required': return 'is required';
      case 'type': return `must be ${[].concat(p.type).map((t: string) => TYPE_TEXT[t] ?? t).join(' or ')}`;
      case 'enum': return `must be one of: ${(p.allowedValues as unknown[]).join(', ')}`;
      case 'minLength': return p.limit === 1 ? "can't be empty" : `must be at least ${p.limit} characters`;
      case 'maxLength': return `can have at most ${p.limit} characters`;
      case 'minimum': return `must be at least ${p.limit}`;
      case 'maximum': return `must be at most ${p.limit}`;
      case 'exclusiveMinimum': return `must be greater than ${p.limit}`;
      case 'exclusiveMaximum': return `must be less than ${p.limit}`;
      case 'minItems': return `needs at least ${plural(p.limit)}`;
      case 'maxItems': return `can have at most ${plural(p.limit)}`;
      case 'pattern': return "isn't in the expected format";
      case 'format': return `isn't a valid ${p.format}`;
      default: return "isn't valid";
    }
  })();
  const label = fieldLabel(path);
  return { field: path.join('.'), message: `${label.charAt(0).toUpperCase()}${label.slice(1)} ${phrase}` };
}

export function formatErrors(errors: ErrorObject[] | null | undefined): FieldError[] {
  return (errors ?? []).map(describeError);
}

/** Success bodies keep `{ success, message, data, meta? }`; every non-2xx goes through the one error contract. */
export function envelope(params: { statusCode: number; data?: any; error?: any; meta?: any; message?: string }) {
  const { statusCode, data, error, meta, message } = params;
  const success = statusCode >= 200 && statusCode < 300;

  if (!success) {
    const { code, message: errorText, details, ...extras } = error ?? {};
    const text = plainMessage(statusCode, message || errorText);
    const extra: ErrorDetails = { ...extras, ...(Array.isArray(details) ? { fields: details } : details) };
    return { statusCode, body: JSON.stringify(errorBody(code ?? defaultsFor(statusCode).code, text ?? defaultsFor(statusCode).message, extra)) };
  }

  const body: any = { success, message: message || 'Success', data: data ?? null };
  if (meta) body.meta = meta;
  return { statusCode, body: JSON.stringify(body) };
}

export enum ErrorCodes {
  UNAUTHORIZED = 'UNAUTHORIZED',
  NOT_FOUND = 'NOT_FOUND',
  VALIDATION_ERROR = 'VALIDATION_ERROR',
  METHOD_NOT_ALLOWED = 'METHOD_NOT_ALLOWED',
  INTERNAL_ERROR = 'INTERNAL_ERROR',
  ITEM_TOO_LARGE = 'ITEM_TOO_LARGE',
  EMAIL_NOT_VERIFIED = 'EMAIL_NOT_VERIFIED',
  USER_EXISTS = 'USER_EXISTS',
  RULE_IN_USE = 'RULE_IN_USE',
  SUBSCRIPTION_REQUIRED = 'SUBSCRIPTION_REQUIRED',
  RATE_LIMITED = 'RATE_LIMITED',
  FORBIDDEN = 'FORBIDDEN',
  CODE_INVALID = 'CODE_INVALID',
  CODE_EXPIRED = 'CODE_EXPIRED',
  ALREADY_CONFIRMED = 'ALREADY_CONFIRMED',
  BAD_GATEWAY = 'BAD_GATEWAY',
  GATEWAY_TIMEOUT = 'GATEWAY_TIMEOUT',
  SERVICE_UNAVAILABLE = 'SERVICE_UNAVAILABLE',
  AI_UNAVAILABLE = 'AI_UNAVAILABLE',
  MISSING_SIGNATURE = 'MISSING_SIGNATURE',
  INVALID_SIGNATURE = 'INVALID_SIGNATURE',
  WEBHOOK_PROCESSING_FAILED = 'WEBHOOK_PROCESSING_FAILED',
  GEMINI_TIMEOUT = 'GEMINI_TIMEOUT',
  GEMINI_ERROR = 'GEMINI_ERROR',
  EXTRACTION_FAILED = 'EXTRACTION_FAILED'
}

/** `details` is a list of field errors (validation) or the extras object (`{ retryAfter }`); both land in `error`. */
export function errorResponse(statusCode: number, code: ErrorCodes, message: string, details?: ErrorDetails | FieldError[]) {
  return envelope({ statusCode, error: { code, message, details }, message });
}

// Estimates DynamoDB item size in bytes (DynamoDB limit is 400KB)
export function calculateItemSize(item: any): number {
  // Convert the item to a JSON string and get its byte length
  // This is an approximation as DynamoDB calculates size differently (e.g., attribute names count)
  // but it's a good enough heuristic for pre-checking.
  return Buffer.byteLength(JSON.stringify(item), 'utf8');
}

// Standardized exception serialization (include message & stack in dev / always if INTERNAL_ERROR exposure desired)

// Standardized exception serialization (include message & stack in dev / always if INTERNAL_ERROR exposure desired)
export function serializeException(err: any, opts?: { exposeStack?: boolean }) {
  if (!err) return null;
  return {
    message: err.message || String(err),
    name: err.name || 'Error',
    stack: opts?.exposeStack ? (err.stack || null) : undefined
  };
}

/** 500 envelope for an unexpected exception. The cause is logged by the caller; the body never carries the raw message or stack. */
export function errorFromException(_err: any, _exposeStack = false) {
  return errorResponse(500, ErrorCodes.INTERNAL_ERROR, defaultsFor(500).message);
}
