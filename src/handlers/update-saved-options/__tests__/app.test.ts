import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBDocumentClient, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import type { APIGatewayProxyEventV2 } from 'aws-lambda';

// Mock environment variables before importing handler
vi.stubEnv('SAVED_OPTIONS_TABLE', 'test-saved-options');

// Must import handler after env stubs
const { handler } = await import('../app.ts');

const ddbMock = mockClient(DynamoDBDocumentClient);

// --- Helpers ----------------------------------------------------------------

function makeJwt(sub: string): string {
  const header = btoa(JSON.stringify({ alg: 'RS256' }));
  const payload = btoa(JSON.stringify({ sub }));
  return `${header}.${payload}.sig`;
}

function makeEvent(body: any, overrides: Partial<APIGatewayProxyEventV2> = {}): APIGatewayProxyEventV2 {
  return {
    version: '2.0',
    routeKey: 'PUT /saved-options',
    rawPath: '/saved-options',
    rawQueryString: '',
    headers: {
      authorization: `Bearer ${makeJwt('user-1')}`,
      ...((overrides as any).headers || {}),
    },
    requestContext: {
      accountId: '123',
      apiId: 'api',
      domainName: 'api.example.com',
      domainPrefix: 'api',
      http: { method: 'PUT', path: '/saved-options', protocol: 'HTTP/1.1', sourceIp: '127.0.0.1', userAgent: 'test' },
      requestId: 'req-1',
      routeKey: 'PUT /saved-options',
      stage: '$default',
      time: '01/Jan/2024:00:00:00 +0000',
      timeEpoch: 0,
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
    isBase64Encoded: false,
    ...overrides,
  } as unknown as APIGatewayProxyEventV2;
}

const validOptions = {
  symbols: ['AAPL', 'MSFT'],
  strategies: ['Breakout'],
  sessions: ['London'],
  marketConditions: ['Trending'],
  newsEvents: ['FOMC'],
  mistakes: ['FOMO'],
  lessons: ['Wait for confirmation'],
  timeframes: ['1h', '4h'],
};

// --- Tests ------------------------------------------------------------------

/** What UpdateItem would answer: the stored item with the SET attributes applied. */
const stored = (existing: Record<string, any> = {}) => (input: any) => {
  const names = input.ExpressionAttributeNames as Record<string, string>;
  const values = input.ExpressionAttributeValues as Record<string, any>;
  const attrs: Record<string, any> = { userId: 'user-1', ...existing };
  for (const [n, field] of Object.entries(names)) {
    if (n.startsWith('#c')) attrs[field] = values[`:v${n.slice(2)}`];
  }
  attrs.updatedAt = values[':now'];
  attrs.createdAt = existing.createdAt ?? values[':now'];
  return { Attributes: attrs };
};

beforeEach(() => {
  ddbMock.reset();
  ddbMock.on(UpdateCommand).callsFake(stored());
});

describe('update-saved-options handler', () => {
  // -- Success ---------------------------------------------------------------

  it('updates saved options and returns 200', async () => {
    const res = await handler(makeEvent(validOptions), {} as any, () => {}) as any;

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(true);
    expect(body.data.symbols).toEqual(['AAPL', 'MSFT']);
    expect(body.data.strategies).toEqual(['Breakout']);
    expect(body.data.sessions).toEqual(['London']);
    expect(body.data.updatedAt).toBeDefined();

    expect(ddbMock.commandCalls(UpdateCommand)).toHaveLength(1);
  });

  // -- Auth ------------------------------------------------------------------

  it('returns 401 when authorization header is missing', async () => {
    const event = makeEvent(validOptions);
    event.headers = {};
    const res = await handler(event, {} as any, () => {}) as any;

    expect(res.statusCode).toBe(401);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(false);
    expect(body.errorCode).toBe('UNAUTHORIZED');
  });

  // -- Validation: missing body ----------------------------------------------

  it('returns 400 when body is missing', async () => {
    const event = makeEvent(undefined);
    event.body = undefined;
    const res = await handler(event, {} as any, () => {}) as any;

    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.errorCode).toBe('VALIDATION_ERROR');
    expect(body.message).toContain('Missing body');
  });

  // -- Validation: invalid JSON ----------------------------------------------

  it('returns 400 when body is invalid JSON', async () => {
    const event = makeEvent(validOptions);
    event.body = '{not-valid-json';
    const res = await handler(event, {} as any, () => {}) as any;

    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.errorCode).toBe('VALIDATION_ERROR');
    expect(body.message).toContain('Invalid JSON');
  });

  // -- Validation: invalid category name -------------------------------------

  it('returns 400 when an invalid category name is provided', async () => {
    const res = await handler(makeEvent({ invalidCategory: ['value'] }), {} as any, () => {}) as any;

    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.errorCode).toBe('VALIDATION_ERROR');
    expect(body.message).toContain('Invalid category');
  });

  // -- Validation: category value not array ----------------------------------

  it('returns 400 when a category value is not an array', async () => {
    const res = await handler(makeEvent({ symbols: 'not-an-array' }), {} as any, () => {}) as any;

    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.errorCode).toBe('VALIDATION_ERROR');
    expect(body.message).toContain('must be an array');
  });

  // -- Validation: array items not strings -----------------------------------

  it('returns 400 when array items are not strings', async () => {
    const res = await handler(makeEvent({ symbols: [123, true] }), {} as any, () => {}) as any;

    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.errorCode).toBe('VALIDATION_ERROR');
    expect(body.message).toContain('must be strings');
  });

  // -- createdAt allowlist ----------------------------------------------------

  it('does not reject payload containing createdAt field', async () => {
    const payload = { ...validOptions, createdAt: '2024-06-01T00:00:00.000Z' };
    const res = await handler(makeEvent(payload), {} as any, () => {}) as any;

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(true);
    // createdAt should not trigger "Invalid category" error
    expect(body.data.symbols).toEqual(['AAPL', 'MSFT']);
  });

  // -- Partial update (BE-098) -----------------------------------------------

  it('writes only the categories that were sent, so the others cannot be overwritten with an older copy', async () => {
    const existingOptions = { symbols: ['TSLA', 'GOOG'], strategies: ['Scalping'], createdAt: '2024-01-01T00:00:00.000Z' };
    ddbMock.on(UpdateCommand).callsFake(stored(existingOptions));

    const res = await handler(makeEvent({ tags: ['swing'] }), {} as any, () => {}) as any;

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.data.tags).toEqual(['swing']);
    // untouched categories keep what is stored, missing ones are empty lists
    expect(body.data.symbols).toEqual(['TSLA', 'GOOG']);
    expect(body.data.strategies).toEqual(['Scalping']);
    expect(body.data.sessions).toEqual([]);

    const input = ddbMock.commandCalls(UpdateCommand)[0].args[0].input as any;
    expect(Object.values(input.ExpressionAttributeNames)).toEqual(expect.arrayContaining(['tags', 'updatedAt', 'createdAt']));
    expect(Object.values(input.ExpressionAttributeNames)).not.toContain('symbols');
    expect(input.UpdateExpression).toContain('if_not_exists(#createdAt, :now)');
    expect(input.Key).toEqual({ userId: 'user-1' });
  });

  it('caps a category at 500 entries of 200 characters', async () => {
    const tooMany = await handler(makeEvent({ symbols: Array.from({ length: 501 }, (_, i) => `S${i}`) }), {} as any, () => {}) as any;
    expect(tooMany.statusCode).toBe(400);
    const tooLong = await handler(makeEvent({ mistakes: ['x'.repeat(201)] }), {} as any, () => {}) as any;
    expect(tooLong.statusCode).toBe(400);
    const edge = await handler(makeEvent({ symbols: Array.from({ length: 500 }, (_, i) => `S${i}`), mistakes: ['x'.repeat(200)] }), {} as any, () => {}) as any;
    expect(edge.statusCode).toBe(200);
  });

  // -- DynamoDB error --------------------------------------------------------

  it('returns 500 when DynamoDB write fails', async () => {
    ddbMock.on(UpdateCommand).rejects(new Error('DynamoDB write error'));

    const res = await handler(makeEvent(validOptions), {} as any, () => {}) as any;

    expect(res.statusCode).toBe(500);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(false);
    expect(body.errorCode).toBe('INTERNAL_ERROR');
  });
});
