import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBDocumentClient, GetCommand } from '@aws-sdk/lib-dynamodb';
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

function makeEvent(overrides: Partial<APIGatewayProxyEventV2> = {}): APIGatewayProxyEventV2 {
  return {
    version: '2.0',
    routeKey: 'GET /saved-options',
    rawPath: '/saved-options',
    rawQueryString: '',
    headers: {
      authorization: `Bearer ${makeJwt('user-1')}`,
    },
    requestContext: {
      accountId: '123',
      apiId: 'api',
      domainName: 'api.example.com',
      domainPrefix: 'api',
      http: { method: 'GET', path: '/saved-options', protocol: 'HTTP/1.1', sourceIp: '127.0.0.1', userAgent: 'test' },
      requestId: 'req-1',
      routeKey: 'GET /saved-options',
      stage: '$default',
      time: '01/Jan/2024:00:00:00 +0000',
      timeEpoch: 0,
    },
    isBase64Encoded: false,
    ...overrides,
  } as APIGatewayProxyEventV2;
}

// --- Tests ------------------------------------------------------------------

beforeEach(() => {
  ddbMock.reset();
});

describe('get-saved-options handler', () => {
  // -- Success with stored options -------------------------------------------

  it('returns stored saved options for authenticated user', async () => {
    const storedOptions = {
      userId: 'user-1',
      symbols: ['AAPL', 'MSFT'],
      strategies: ['Breakout', 'Reversal'],
      sessions: ['London', 'New York'],
      marketConditions: ['Trending'],
      newsEvents: ['FOMC'],
      mistakes: ['FOMO'],
      lessons: ['Wait for confirmation'],
      timeframes: ['1h', '4h'],
    };
    ddbMock.on(GetCommand).resolves({ Item: storedOptions });

    const res = await handler(makeEvent(), {} as any, () => {}) as any;

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(true);
    expect(body.data.symbols).toEqual(['AAPL', 'MSFT']);
    expect(body.data.strategies).toEqual(['Breakout', 'Reversal']);
    expect(body.data.sessions).toEqual(['London', 'New York']);
    expect(body.data.marketConditions).toEqual(['Trending']);
    expect(body.data.newsEvents).toEqual(['FOMC']);
    expect(body.data.mistakes).toEqual(['FOMO']);
    expect(body.data.lessons).toEqual(['Wait for confirmation']);
    expect(body.data.timeframes).toEqual(['1h', '4h']);
  });

  // -- Success returns defaults when no options stored -----------------------

  it('returns default empty arrays when no options are stored', async () => {
    ddbMock.on(GetCommand).resolves({ Item: undefined });

    const res = await handler(makeEvent(), {} as any, () => {}) as any;

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(true);
    expect(body.data.symbols).toEqual([]);
    expect(body.data.strategies).toEqual([]);
    expect(body.data.sessions).toEqual([]);
    expect(body.data.marketConditions).toEqual([]);
    expect(body.data.newsEvents).toEqual([]);
    expect(body.data.mistakes).toEqual([]);
    expect(body.data.lessons).toEqual([]);
    expect(body.data.timeframes).toEqual([]);
  });

  // -- Auth ------------------------------------------------------------------

  it('returns 401 when authorization header is missing', async () => {
    const event = makeEvent({ headers: {} });
    const res = await handler(event, {} as any, () => {}) as any;

    expect(res.statusCode).toBe(401);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(false);
    expect(body.errorCode).toBe('UNAUTHORIZED');
  });

  // -- DynamoDB error --------------------------------------------------------

  it('returns 500 when DynamoDB query fails', async () => {
    ddbMock.on(GetCommand).rejects(new Error('DynamoDB timeout'));

    const res = await handler(makeEvent(), {} as any, () => {}) as any;

    expect(res.statusCode).toBe(500);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(false);
    expect(body.errorCode).toBe('INTERNAL_ERROR');
  });

  it('returns 500 with correct error message when DynamoDB fails', async () => {
    ddbMock.on(GetCommand).rejects(new Error('Service unavailable'));

    const res = await handler(makeEvent(), {} as any, () => {}) as any;

    expect(res.statusCode).toBe(500);
    const body = JSON.parse(res.body);
    expect(body.message).toBe('Failed to retrieve saved options');
  });

  // -- Auth edge cases ------------------------------------------------------

  it('returns 401 when token is malformed (no sub claim)', async () => {
    const badHeader = btoa(JSON.stringify({ alg: 'RS256' }));
    const badPayload = btoa(JSON.stringify({ iss: 'bad' }));
    const event = makeEvent({ headers: { authorization: `Bearer ${badHeader}.${badPayload}.sig` } });
    const res = await handler(event, {} as any, () => {}) as any;

    expect(res.statusCode).toBe(401);
    const body = JSON.parse(res.body);
    expect(body.errorCode).toBe('UNAUTHORIZED');
  });

  it('returns 401 when authorization header has empty Bearer token', async () => {
    const event = makeEvent({ headers: { authorization: 'Bearer ' } });
    const res = await handler(event, {} as any, () => {}) as any;

    expect(res.statusCode).toBe(401);
    const body = JSON.parse(res.body);
    expect(body.errorCode).toBe('UNAUTHORIZED');
  });

  // -- Options with special characters --------------------------------------

  it('returns options with special characters in values', async () => {
    const specialOptions = {
      userId: 'user-1',
      symbols: ['NIFTY 50', 'BANK-NIFTY', 'S&P 500'],
      strategies: ['Break & Retest', "Don't Chase"],
      sessions: ['Asia/Tokyo (UTC+9)'],
      marketConditions: ['Range-bound <low vol>'],
      newsEvents: ['CPI @ 8:30am'],
      mistakes: [],
      lessons: [],
      timeframes: ['1m', '5m', '15m'],
    };
    ddbMock.on(GetCommand).resolves({ Item: specialOptions });

    const res = await handler(makeEvent(), {} as any, () => {}) as any;

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.data.symbols).toEqual(['NIFTY 50', 'BANK-NIFTY', 'S&P 500']);
    expect(body.data.strategies).toEqual(['Break & Retest', "Don't Chase"]);
    expect(body.data.sessions).toEqual(['Asia/Tokyo (UTC+9)']);
    expect(body.data.marketConditions).toEqual(['Range-bound <low vol>']);
  });

  // -- Large options lists --------------------------------------------------

  it('returns large options lists correctly', async () => {
    const manySymbols = Array.from({ length: 100 }, (_, i) => `SYM-${i}`);
    const largeOptions = {
      userId: 'user-1',
      symbols: manySymbols,
      strategies: ['A'],
      sessions: [],
      marketConditions: [],
      newsEvents: [],
      mistakes: [],
      lessons: [],
      timeframes: [],
    };
    ddbMock.on(GetCommand).resolves({ Item: largeOptions });

    const res = await handler(makeEvent(), {} as any, () => {}) as any;

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.data.symbols).toHaveLength(100);
    expect(body.data.symbols[0]).toBe('SYM-0');
    expect(body.data.symbols[99]).toBe('SYM-99');
  });

  // -- Partial options (some fields populated, others missing) --------------

  it('returns stored options even when some categories are missing from DB', async () => {
    const partialOptions = {
      userId: 'user-1',
      symbols: ['AAPL'],
      // strategies, sessions, etc. not stored
    };
    ddbMock.on(GetCommand).resolves({ Item: partialOptions });

    const res = await handler(makeEvent(), {} as any, () => {}) as any;

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    // Returns whatever is in the Item, missing fields will be undefined (not default)
    expect(body.data.symbols).toEqual(['AAPL']);
    expect(body.data.userId).toBe('user-1');
  });

  // -- Response shape -------------------------------------------------------

  it('response body contains success true and message "Saved options retrieved"', async () => {
    ddbMock.on(GetCommand).resolves({ Item: undefined });

    const res = await handler(makeEvent(), {} as any, () => {}) as any;

    const body = JSON.parse(res.body);
    expect(body.success).toBe(true);
    expect(body.message).toBe('Saved options retrieved');
  });

  // -- Ensures user isolation -----------------------------------------------

  it('returns options keyed to the authenticated user (user-1)', async () => {
    const userOptions = {
      userId: 'user-1',
      symbols: ['TSLA'],
      strategies: [],
      sessions: [],
      marketConditions: [],
      newsEvents: [],
      mistakes: [],
      lessons: [],
      timeframes: [],
    };
    ddbMock.on(GetCommand).resolves({ Item: userOptions });

    const res = await handler(makeEvent(), {} as any, () => {}) as any;

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.data.userId).toBe('user-1');
    expect(body.data.symbols).toEqual(['TSLA']);
  });
});
