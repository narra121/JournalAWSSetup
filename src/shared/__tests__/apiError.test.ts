import { describe, expect, it } from 'vitest';
import { defaultsFor, errorBody, normalizeErrorBody, plainMessage, toErrorCode } from '../apiError';

describe('errorBody', () => {
  it('is the contract: message === errorMessage, no error object without extras', () => {
    expect(errorBody('VALIDATION_ERROR', 'A trade can have at most 6 images')).toEqual({
      success: false,
      message: 'A trade can have at most 6 images',
      errorCode: 'VALIDATION_ERROR',
      errorMessage: 'A trade can have at most 6 images',
    });
  });

  it('puts retryAfter and plan data under error, with the code repeated', () => {
    expect(errorBody('RATE_LIMITED', 'Too many attempts', { retryAfter: 42 }).error).toEqual({ code: 'RATE_LIMITED', retryAfter: 42 });
    expect(errorBody('QUOTA_EXCEEDED', 'Out', { feature: 'ai_chat', limit: 5, used: 5, resetsAt: '2026-12-01T00:00:00.000Z', plan: 'free' }).error).toEqual({
      code: 'QUOTA_EXCEEDED',
      feature: 'ai_chat',
      limit: 5,
      used: 5,
      resetsAt: '2026-12-01T00:00:00.000Z',
      plan: 'free',
    });
  });

  it('turns a list of field errors into error.fields and a message that names the first problem', () => {
    const fields = [{ field: 'symbol', message: 'Symbol is required' }, { field: 'side', message: 'Side is required' }, { field: 'quantity', message: 'Quantity is required' }];
    const body = errorBody('VALIDATION_ERROR', 'Invalid request body', fields);
    expect(body.message).toBe('Symbol is required (and 2 more)');
    expect(body.errorMessage).toBe(body.message);
    expect(body.error).toEqual({ code: 'VALIDATION_ERROR', fields });
    expect(errorBody('VALIDATION_ERROR', 'Invalid request body', [fields[0]]).message).toBe('Symbol is required');
  });

  it('drops an empty fields list and a non-numeric retryAfter, and never leaves the message empty', () => {
    const body = errorBody('X', '   ', { fields: [], retryAfter: 'soon' as unknown as number });
    expect(body.error).toBeUndefined();
    expect(body.message).toBe('Something went wrong. Please try again.');
  });

  it('carries requestId for 5xx', () => {
    expect(errorBody('INTERNAL_ERROR', 'Oops', {}, 'req-1').requestId).toBe('req-1');
  });
});

describe('toErrorCode', () => {
  it.each([
    ['BadRequest', 'BAD_REQUEST'],
    ['GeminiTimeout', 'GEMINI_TIMEOUT'],
    ['InternalServerError', 'INTERNAL_SERVER_ERROR'],
    ['bad-request', 'BAD_REQUEST'],
    ['VALIDATION_ERROR', 'VALIDATION_ERROR'],
    ['RATE_LIMITED', 'RATE_LIMITED'],
  ])('%s -> %s', (input, expected) => expect(toErrorCode(input)).toBe(expected));
});

describe('plainMessage', () => {
  it('replaces one-word messages with the sentence for the status and keeps specific ones', () => {
    expect(plainMessage(404, 'Not found')).toBe("We couldn't find what you asked for.");
    expect(plainMessage(401, 'Unauthorized')).toBe('Your session has ended. Please log in again.');
    expect(plainMessage(500, 'Internal error')).toBe(defaultsFor(500).message);
    expect(plainMessage(404, 'Image not found')).toBe('Image not found');
    expect(plainMessage(400, undefined)).toBeUndefined();
  });
});

describe('normalizeErrorBody: every shape the API used to send becomes the contract', () => {
  const contract = (status: number, body: unknown) => normalizeErrorBody(status, typeof body === 'string' ? body : JSON.stringify(body));

  it('leaves a contract body unchanged (idempotent)', () => {
    const once = errorBody('RATE_LIMITED', 'Wait', { retryAfter: 9 });
    expect(normalizeErrorBody(429, JSON.stringify(once))).toEqual(once);
    expect(normalizeErrorBody(429, JSON.stringify(normalizeErrorBody(429, JSON.stringify(once))))).toEqual(once);
  });

  it('keeps the owner example', () => {
    expect(contract(400, { success: false, message: 'A trade can have at most 6 images', errorCode: 'VALIDATION_ERROR', errorMessage: 'A trade can have at most 6 images' })).toEqual({
      success: false,
      message: 'A trade can have at most 6 images',
      errorCode: 'VALIDATION_ERROR',
      errorMessage: 'A trade can have at most 6 images',
    });
  });

  it('{ error: "text" } (old get-image)', () => {
    expect(contract(400, { error: 'Only JPG images' })).toMatchObject({ message: 'Only JPG images', errorCode: 'VALIDATION_ERROR', errorMessage: 'Only JPG images' });
  });

  it('{ message } only (old auth middleware)', () => {
    expect(contract(401, { message: 'Unauthorized' })).toMatchObject({ message: 'Your session has ended. Please log in again.', errorCode: 'UNAUTHORIZED' });
    expect(contract(403, { message: 'Forbidden' })).toMatchObject({ message: "You don't have permission to do that.", errorCode: 'FORBIDDEN' });
  });

  it('{ data, error: { code, message }, meta } (old Stripe webhook)', () => {
    expect(contract(400, { data: null, error: { code: 'MISSING_SIGNATURE', message: 'Missing stripe-signature header' }, meta: null })).toEqual({
      success: false,
      message: 'Missing stripe-signature header',
      errorCode: 'MISSING_SIGNATURE',
      errorMessage: 'Missing stripe-signature header',
    });
  });

  it('CamelCase codes become UPPER_SNAKE and message wins over errorMessage', () => {
    expect(contract(502, { success: false, message: 'Failed to enhance text', errorCode: 'BadGateway', errorMessage: 'Gemini API error: 502' })).toMatchObject({
      message: 'Failed to enhance text',
      errorMessage: 'Failed to enhance text',
      errorCode: 'BAD_GATEWAY',
    });
  });

  it('errors[0].retryAfter (old 429) moves to error.retryAfter', () => {
    expect(contract(429, { success: false, message: 'Too many attempts', errorCode: 'RATE_LIMITED', errorMessage: 'Too many attempts', errors: [{ retryAfter: 290 }] })).toEqual({
      success: false,
      message: 'Too many attempts',
      errorCode: 'RATE_LIMITED',
      errorMessage: 'Too many attempts',
      error: { code: 'RATE_LIMITED', retryAfter: 290 },
    });
  });

  it('errors[] field list (old validation) moves to error.fields', () => {
    const body = contract(400, { success: false, message: 'Invalid request body', errorCode: 'VALIDATION_ERROR', errors: [{ code: 'VALIDATION_ERROR', field: 'symbol', message: 'Symbol is required' }] });
    expect(body.message).toBe('Symbol is required');
    expect(body.error).toEqual({ code: 'VALIDATION_ERROR', fields: [{ field: 'symbol', message: 'Symbol is required' }] });
  });

  it('flattens error.details (old subscription 403) and keeps 402 plan data', () => {
    expect(contract(403, { success: false, message: 'Subscription required', errorCode: 'SUBSCRIPTION_REQUIRED', error: { code: 'SUBSCRIPTION_REQUIRED', message: 'x', details: { reason: 'expired', renewUrl: '/app/profile' } } }).error).toEqual({
      code: 'SUBSCRIPTION_REQUIRED',
      reason: 'expired',
      renewUrl: '/app/profile',
    });
    expect(contract(402, { success: false, message: 'Out', errorCode: 'QUOTA_EXCEEDED', errorMessage: 'Out', error: { code: 'QUOTA_EXCEEDED', feature: 'ai_chat', limit: 3, used: 3, resetsAt: '2026-12-01', plan: 'free' } }).error).toEqual({
      code: 'QUOTA_EXCEEDED',
      feature: 'ai_chat',
      limit: 3,
      used: 3,
      resetsAt: '2026-12-01',
      plan: 'free',
    });
  });

  it('keeps requestId', () => {
    expect(contract(500, { success: false, message: 'Oops', errorCode: 'INTERNAL_ERROR', requestId: 'abc' }).requestId).toBe('abc');
  });

  it.each([
    [400, 'VALIDATION_ERROR'],
    [401, 'UNAUTHORIZED'],
    [403, 'FORBIDDEN'],
    [404, 'NOT_FOUND'],
    [405, 'METHOD_NOT_ALLOWED'],
    [409, 'CONFLICT'],
    [413, 'PAYLOAD_TOO_LARGE'],
    [422, 'UNPROCESSABLE'],
    [429, 'RATE_LIMITED'],
    [500, 'INTERNAL_ERROR'],
    [502, 'BAD_GATEWAY'],
    [503, 'SERVICE_UNAVAILABLE'],
    [504, 'GATEWAY_TIMEOUT'],
  ])('text, HTML and empty bodies at %i fall back to the status sentence (%s), never the raw text', (status, code) => {
    for (const raw of ['Internal Server Error', '<html><h1>429 Too Many Requests</h1><p>Request ID: abc</p></html>', '', undefined, 'null', '[1,2]']) {
      const body = normalizeErrorBody(status, raw);
      expect(body).toEqual(errorBody(code, defaultsFor(status).message));
      expect(body.errorMessage).toBe(body.message);
    }
  });

  it('an unlisted 5xx / 4xx falls back to the 500 / 400 sentence', () => {
    expect(normalizeErrorBody(507, '').errorCode).toBe('INTERNAL_ERROR');
    expect(normalizeErrorBody(418, '').errorCode).toBe('VALIDATION_ERROR');
  });
});
