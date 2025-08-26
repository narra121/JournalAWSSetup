import Ajv, { ErrorObject } from 'ajv';
import addFormats from 'ajv-formats';

const ajv = new Ajv({ allErrors: true, removeAdditional: true, useDefaults: true });
addFormats(ajv);

const schemaCache: Record<string, any> = {};

export function getValidator(schema: object, key: string) {
  if (!schemaCache[key]) {
    schemaCache[key] = ajv.compile(schema as any);
  }
  return schemaCache[key];
}

export interface ValidationResult { valid: boolean; errors?: { code: string; field: string; message: string }[] }

export function formatErrors(errors: ErrorObject[] | null | undefined): ValidationResult['errors'] {
  if (!errors) return [];
  return errors.map(e => ({
    code: 'VALIDATION_ERROR',
    field: e.instancePath || e.schemaPath,
    message: e.message || 'invalid'
  }));
}

export function envelope(params: { statusCode: number; data?: any; error?: any; meta?: any }) {
  const { statusCode, data, error, meta } = params;
  return {
    statusCode,
    body: JSON.stringify({ data: data ?? null, error: error ?? null, meta: meta ?? null })
  };
}

export enum ErrorCodes {
  UNAUTHORIZED = 'UNAUTHORIZED',
  NOT_FOUND = 'TRADE_NOT_FOUND',
  VALIDATION_ERROR = 'VALIDATION_ERROR',
  INTERNAL_ERROR = 'INTERNAL_ERROR',
  ITEM_TOO_LARGE = 'ITEM_TOO_LARGE'
}

export function errorResponse(statusCode: number, code: ErrorCodes, message: string, details?: any) {
  return envelope({ statusCode, error: { code, message, details } });
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

export function errorFromException(err: any, exposeStack = true) {
  return envelope({ statusCode: 500, error: { code: ErrorCodes.INTERNAL_ERROR, message: err?.message || 'Internal error', exception: serializeException(err, { exposeStack }) } });
}
