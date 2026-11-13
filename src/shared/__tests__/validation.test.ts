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

  it('maps AJV errors to { field, message } sentences a trader can read', () => {
    const ajvErrors = [
      { instancePath: '/name', schemaPath: '#/properties/name/minLength', message: 'must NOT have fewer than 1 characters', keyword: 'minLength', params: { limit: 1 } },
      { instancePath: '', schemaPath: '#/required', message: "must have required property 'name'", keyword: 'required', params: { missingProperty: 'name' } },
    ] as any;

    expect(formatErrors(ajvErrors)).toEqual([
      { field: 'name', message: "Name can't be empty" },
      { field: 'name', message: 'Name is required' },
    ]);
  });

  it.each([
    [{ instancePath: '/entryPrice', keyword: 'type', params: { type: 'number' } }, 'entryPrice', 'Entry price must be a number'],
    [{ instancePath: '/side', keyword: 'enum', params: { allowedValues: ['BUY', 'SELL'] } }, 'side', 'Side must be one of: BUY, SELL'],
    [{ instancePath: '/notes', keyword: 'maxLength', params: { limit: 5000 } }, 'notes', 'Notes can have at most 5000 characters'],
    [{ instancePath: '/quantity', keyword: 'minimum', params: { limit: 0 } }, 'quantity', 'Quantity must be at least 0'],
    [{ instancePath: '/tags', keyword: 'maxItems', params: { limit: 50 } }, 'tags', 'Tags can have at most 50 items'],
    [{ instancePath: '/images/3/timeframe', keyword: 'type', params: { type: 'string' } }, 'images.3.timeframe', 'Image 4 timeframe must be text'],
    [{ instancePath: '/images/2', keyword: 'type', params: { type: 'object' } }, 'images.2', 'Image 3 must be an object'],
    [{ instancePath: '/email', keyword: 'format', params: { format: 'email' } }, 'email', "Email isn't a valid email"],
    [{ instancePath: '/exitDate', keyword: 'pattern', params: { pattern: '^x$' } }, 'exitDate', "Exit date isn't in the expected format"],
    [{ instancePath: '', keyword: 'type', params: { type: 'object' } }, '', 'The request must be an object'],
    [{ instancePath: '/foo', keyword: 'oneOf', params: {} }, 'foo', "Foo isn't valid"],
  ])('describes %j', (error, field, message) => {
    expect(formatErrors([error] as any)).toEqual([{ field, message }]);
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

  it('creates an error response in the one error contract: errorCode, message === errorMessage, fields under error', () => {
    const res = envelope({
      statusCode: 400,
      error: { code: 'BAD', message: 'bad request', details: [{ field: 'x', message: 'X is required' }] },
      message: 'Validation failed',
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body)).toEqual({
      success: false,
      message: 'X is required',
      errorCode: 'BAD',
      errorMessage: 'X is required',
      error: { code: 'BAD', fields: [{ field: 'x', message: 'X is required' }] },
    });
  });

  it('puts an object in details (retryAfter) under error and keeps the message', () => {
    const res = envelope({ statusCode: 429, error: { code: 'RATE_LIMITED', message: 'Too many attempts', details: { retryAfter: 42 } } });
    expect(JSON.parse(res.body)).toEqual({
      success: false,
      message: 'Too many attempts',
      errorCode: 'RATE_LIMITED',
      errorMessage: 'Too many attempts',
      error: { code: 'RATE_LIMITED', retryAfter: 42 },
    });
  });

  it('includes meta if provided', () => {
    const res = envelope({ statusCode: 200, data: null, meta: { page: 1 } });
    const body = JSON.parse(res.body);
    expect(body.meta).toEqual({ page: 1 });
  });

  it('uses the status sentence for a non-success without a message', () => {
    const res = envelope({ statusCode: 500, error: { code: 'X' } });
    const body = JSON.parse(res.body);
    expect(body.message).toBe('Something went wrong on our side. Please try again.');
    expect(body.errorMessage).toBe(body.message);
    expect(body.errorCode).toBe('X');
  });
});

// ─── errorResponse ──────────────────────────────────────────────

describe('errorResponse', () => {
  it('wraps code and message into an envelope error', () => {
    const res = errorResponse(404, ErrorCodes.NOT_FOUND, 'Not found');
    expect(res.statusCode).toBe(404);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(false);
    expect(body.errorCode).toBe('NOT_FOUND');
    expect(body.message).toBe("We couldn't find what you asked for.");
  });

  it('keeps a specific message and mirrors it in errorMessage', () => {
    const body = JSON.parse(errorResponse(400, ErrorCodes.VALIDATION_ERROR, 'A trade can have at most 6 images').body);
    expect(body).toEqual({
      success: false,
      message: 'A trade can have at most 6 images',
      errorCode: 'VALIDATION_ERROR',
      errorMessage: 'A trade can have at most 6 images',
    });
  });

  it('lists field errors under error.fields and leads with the first one', () => {
    const fields = [{ field: 'email', message: 'Email is required' }, { field: 'name', message: 'Name is required' }];
    const body = JSON.parse(errorResponse(400, ErrorCodes.VALIDATION_ERROR, 'Invalid request body', fields).body);
    expect(body.message).toBe('Email is required (and 1 more)');
    expect(body.error).toEqual({ code: 'VALIDATION_ERROR', fields });
    expect(body.errors).toBeUndefined();
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
  it('returns a 500 envelope with INTERNAL_ERROR code and never the raw message or stack', () => {
    const res = errorFromException(new Error('db timeout at arn:aws:dynamodb:table/Trades'), true);
    expect(res.statusCode).toBe(500);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(false);
    expect(body.errorCode).toBe('INTERNAL_ERROR');
    expect(body.message).toBe('Something went wrong on our side. Please try again.');
    expect(res.body).not.toContain('dynamodb');
    expect(res.body).not.toContain('stack');
  });

  it('handles null error gracefully', () => {
    const res = errorFromException(null);
    expect(res.statusCode).toBe(500);
    const body = JSON.parse(res.body);
    expect(body.message).toBe('Something went wrong on our side. Please try again.');
  });
});

// ─── ErrorCodes enum ────────────────────────────────────────────

describe('ErrorCodes', () => {
  it('has expected values', () => {
    expect(ErrorCodes.UNAUTHORIZED).toBe('UNAUTHORIZED');
    expect(ErrorCodes.NOT_FOUND).toBe('NOT_FOUND');
    expect(ErrorCodes.VALIDATION_ERROR).toBe('VALIDATION_ERROR');
    expect(ErrorCodes.INTERNAL_ERROR).toBe('INTERNAL_ERROR');
    expect(ErrorCodes.EMAIL_NOT_VERIFIED).toBe('EMAIL_NOT_VERIFIED');
    expect(ErrorCodes.USER_EXISTS).toBe('USER_EXISTS');
    expect(ErrorCodes.ITEM_TOO_LARGE).toBe('ITEM_TOO_LARGE');
  });
});
