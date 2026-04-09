import { describe, it, expect } from 'vitest';
import {
  getValidator,
  formatErrors,
  envelope,
  errorResponse,
  ErrorCodes,
  calculateItemSize,
  serializeException,
  errorFromException,
} from '../validation.js';

// ─── getValidator ───────────────────────────────────────────────

describe('getValidator', () => {
  const schema = {
    type: 'object',
    required: ['name'],
    properties: {
      name: { type: 'string', minLength: 1 },
      age: { type: 'number' },
    },
    additionalProperties: false,
  };

  it('returns a compiled validate function', () => {
    const validate = getValidator(schema, 'test-schema');
    expect(typeof validate).toBe('function');
  });

  it('returns true for valid data', () => {
    const validate = getValidator(schema, 'test-schema-valid');
    const result = validate({ name: 'Alice', age: 30 });
    expect(result).toBe(true);
    expect(validate.errors).toBeNull();
  });

  it('returns false and populates errors for invalid data', () => {
    const validate = getValidator(schema, 'test-schema-invalid');
    const result = validate({ age: 'not-a-number' });
    expect(result).toBe(false);
    expect(validate.errors).toBeDefined();
    expect(validate.errors!.length).toBeGreaterThan(0);
  });

  it('caches compiled validators by key', () => {
    const v1 = getValidator(schema, 'cache-key');
    const v2 = getValidator(schema, 'cache-key');
    expect(v1).toBe(v2);
  });
});

// ─── formatErrors ───────────────────────────────────────────────

describe('formatErrors', () => {
  it('returns empty array for null/undefined', () => {
    expect(formatErrors(null)).toEqual([]);
    expect(formatErrors(undefined)).toEqual([]);
  });

  it('maps AJV errors to { code, field, message }', () => {
    const ajvErrors = [
      { instancePath: '/name', schemaPath: '#/properties/name/minLength', message: 'must NOT have fewer than 1 characters', keyword: 'minLength', params: {} },
      { instancePath: '', schemaPath: '#/required', message: "must have required property 'name'", keyword: 'required', params: { missingProperty: 'name' } },
    ] as any;

    const result = formatErrors(ajvErrors);
    expect(result).toHaveLength(2);
    expect(result![0]).toEqual({
      code: 'VALIDATION_ERROR',
      field: '/name',
      message: 'must NOT have fewer than 1 characters',
    });
    // When instancePath is '' (falsy), formatErrors falls back to schemaPath
    expect(result![1].field).toBe('#/required');
    expect(result![1].code).toBe('VALIDATION_ERROR');
  });

  it('falls back to schemaPath when instancePath is empty', () => {
    const ajvErrors = [
      { instancePath: '', schemaPath: '#/required', message: 'required', keyword: 'required', params: {} },
    ] as any;
    const result = formatErrors(ajvErrors);
    // When instancePath is empty string (falsy), it should use instancePath (empty string) || schemaPath
    expect(result![0].field).toBe('#/required');
  });

  it('uses "invalid" when message is missing', () => {
    const ajvErrors = [
      { instancePath: '/foo', schemaPath: '#', keyword: 'type', params: {} },
    ] as any;
    const result = formatErrors(ajvErrors);
    expect(result![0].message).toBe('invalid');
  });
});

// ─── envelope ───────────────────────────────────────────────────

describe('envelope', () => {
  it('creates a success response', () => {
    const res = envelope({ statusCode: 200, data: { id: 1 }, message: 'OK' });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(true);
    expect(body.data).toEqual({ id: 1 });
    expect(body.message).toBe('OK');
  });

  it('sets data to null when data is omitted on success', () => {
    const res = envelope({ statusCode: 200 });
    const body = JSON.parse(res.body);
    expect(body.success).toBe(true);
    expect(body.data).toBeNull();
  });

  it('creates an error response with errorCode and details', () => {
    const res = envelope({
      statusCode: 400,
      error: { code: 'BAD', message: 'bad request', details: [{ field: 'x' }] },
      message: 'Validation failed',
    });
    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(false);
    expect(body.errorCode).toBe('BAD');
    expect(body.errors).toEqual([{ field: 'x' }]);
    expect(body.message).toBe('Validation failed');
  });

  it('includes meta if provided', () => {
    const res = envelope({ statusCode: 200, data: null, meta: { page: 1 } });
    const body = JSON.parse(res.body);
    expect(body.meta).toEqual({ page: 1 });
  });

  it('defaults message to "Error" for non-success without explicit message', () => {
    const res = envelope({ statusCode: 500, error: { code: 'X' } });
    const body = JSON.parse(res.body);
    expect(body.message).toBe('Error');
  });
});

// ─── errorResponse ──────────────────────────────────────────────

describe('errorResponse', () => {
  it('wraps code and message into an envelope error', () => {
    const res = errorResponse(404, ErrorCodes.NOT_FOUND, 'Not found');
    expect(res.statusCode).toBe(404);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(false);
    expect(body.errorCode).toBe('TRADE_NOT_FOUND');
    expect(body.message).toBe('Not found');
  });

  it('includes details array when provided', () => {
    const details = [{ field: '/email', message: 'required' }];
    const res = errorResponse(400, ErrorCodes.VALIDATION_ERROR, 'Bad', details);
    const body = JSON.parse(res.body);
    expect(body.errors).toEqual(details);
  });
});

// ─── calculateItemSize ─────────────────────────────────────────

describe('calculateItemSize', () => {
  it('returns byte length of JSON-serialized item', () => {
    const item = { a: 'hello' };
    const expected = Buffer.byteLength(JSON.stringify(item), 'utf8');
    expect(calculateItemSize(item)).toBe(expected);
  });

  it('handles nested objects', () => {
    const item = { a: { b: { c: [1, 2, 3] } } };
    expect(calculateItemSize(item)).toBeGreaterThan(0);
  });
});

// ─── serializeException ─────────────────────────────────────────

describe('serializeException', () => {
  it('returns null for falsy input', () => {
    expect(serializeException(null)).toBeNull();
    expect(serializeException(undefined)).toBeNull();
  });

  it('serializes an Error object', () => {
    const err = new Error('boom');
    const result = serializeException(err, { exposeStack: true });
    expect(result?.message).toBe('boom');
    expect(result?.name).toBe('Error');
    expect(result?.stack).toBeDefined();
  });

  it('omits stack when exposeStack is false', () => {
    const err = new Error('boom');
    const result = serializeException(err, { exposeStack: false });
    expect(result?.stack).toBeUndefined();
  });

  it('handles non-Error thrown values', () => {
    const result = serializeException('string-error');
    expect(result?.message).toBe('string-error');
    expect(result?.name).toBe('Error');
  });
});

// ─── errorFromException ─────────────────────────────────────────

describe('errorFromException', () => {
  it('returns a 500 envelope with INTERNAL_ERROR code', () => {
    const res = errorFromException(new Error('db timeout'));
    expect(res.statusCode).toBe(500);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(false);
    expect(body.errorCode).toBe('INTERNAL_ERROR');
    expect(body.message).toBe('db timeout');
  });

  it('handles null error gracefully', () => {
    const res = errorFromException(null);
    expect(res.statusCode).toBe(500);
    const body = JSON.parse(res.body);
    expect(body.message).toBe('Internal error');
  });
});

// ─── ErrorCodes enum ────────────────────────────────────────────

describe('ErrorCodes', () => {
  it('has expected values', () => {
    expect(ErrorCodes.UNAUTHORIZED).toBe('UNAUTHORIZED');
    expect(ErrorCodes.NOT_FOUND).toBe('TRADE_NOT_FOUND');
    expect(ErrorCodes.VALIDATION_ERROR).toBe('VALIDATION_ERROR');
    expect(ErrorCodes.INTERNAL_ERROR).toBe('INTERNAL_ERROR');
    expect(ErrorCodes.EMAIL_NOT_VERIFIED).toBe('EMAIL_NOT_VERIFIED');
    expect(ErrorCodes.USER_EXISTS).toBe('USER_EXISTS');
    expect(ErrorCodes.ITEM_TOO_LARGE).toBe('ITEM_TOO_LARGE');
  });
});
