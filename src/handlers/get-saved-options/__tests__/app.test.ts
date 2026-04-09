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
});
