import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBDocumentClient, PutCommand, GetCommand } from '@aws-sdk/lib-dynamodb';
import type { APIGatewayProxyEventV2 } from 'aws-lambda';

// Mock environment variables before importing handler
vi.stubEnv('SAVED_OPTIONS_TABLE', 'test-saved-options');

vi.mock('../../../shared/subscription', () => ({
  checkSubscription: vi.fn().mockResolvedValue(null),
}));

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

beforeEach(() => {
  ddbMock.reset();
  ddbMock.on(GetCommand).resolves({ Item: undefined });
  ddbMock.on(PutCommand).resolves({});
});

describe('update-saved-options handler', () => {
  it('returns 403 when subscription is inactive', async () => {
    const { checkSubscription } = await import('../../../shared/subscription');
    vi.mocked(checkSubscription).mockResolvedValueOnce({
      statusCode: 403,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ success: false, error: { code: 'SUBSCRIPTION_REQUIRED', message: 'Please subscribe', details: { reason: 'trial_expired' } } }),
    } as any);

    const res = await handler(makeEvent(validOptions), {} as any, () => {}) as any;

    expect(res.statusCode).toBe(403);
    const body = JSON.parse(res.body);
    expect(body.error.code).toBe('SUBSCRIPTION_REQUIRED');
  });

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

    // Verify PutCommand was called
    const putCalls = ddbMock.commandCalls(PutCommand);
    expect(putCalls).toHaveLength(1);
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

  // -- Read-merge-write (partial update) ------------------------------------

  it('merges partial update with existing data (read-merge-write)', async () => {
    // Mock GetCommand to return existing saved options
    const existingOptions = {
      userId: 'user-1',
      symbols: ['TSLA', 'GOOG'],
      strategies: ['Scalping'],
      sessions: ['Tokyo'],
      marketConditions: ['Ranging'],
      newsEvents: ['CPI'],
      mistakes: ['Overtrading'],
      lessons: ['Be patient'],
      timeframes: ['15m'],
      updatedAt: '2024-01-01T00:00:00.000Z',
    };
    ddbMock.on(GetCommand).resolves({ Item: existingOptions });

    // Send partial update — only updating symbols
    const partialPayload = { symbols: ['AAPL', 'MSFT'] };
    const res = await handler(makeEvent(partialPayload), {} as any, () => {}) as any;

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(true);

    // Updated field should have new value
    expect(body.data.symbols).toEqual(['AAPL', 'MSFT']);

    // Non-updated fields should retain existing values (merged from GetCommand result)
    expect(body.data.strategies).toEqual(['Scalping']);
    expect(body.data.sessions).toEqual(['Tokyo']);
    expect(body.data.marketConditions).toEqual(['Ranging']);
    expect(body.data.newsEvents).toEqual(['CPI']);
    expect(body.data.mistakes).toEqual(['Overtrading']);
    expect(body.data.lessons).toEqual(['Be patient']);
    expect(body.data.timeframes).toEqual(['15m']);

    // Verify PutCommand was called with merged data
    const putCalls = ddbMock.commandCalls(PutCommand);
    expect(putCalls).toHaveLength(1);
    const putItem = putCalls[0].args[0].input.Item as any;
    expect(putItem.symbols).toEqual(['AAPL', 'MSFT']);
    expect(putItem.strategies).toEqual(['Scalping']);
    expect(putItem.sessions).toEqual(['Tokyo']);
  });

  // -- DynamoDB error --------------------------------------------------------

  it('returns 500 when DynamoDB write fails', async () => {
    ddbMock.on(PutCommand).rejects(new Error('DynamoDB write error'));

    const res = await handler(makeEvent(validOptions), {} as any, () => {}) as any;

    expect(res.statusCode).toBe(500);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(false);
    expect(body.errorCode).toBe('INTERNAL_ERROR');
  });
});
