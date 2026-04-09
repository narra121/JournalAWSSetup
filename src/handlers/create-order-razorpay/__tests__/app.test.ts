import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { APIGatewayProxyEvent } from 'aws-lambda';

// ─── Razorpay mock ─────────────────────────────────────────────
const mockCreate = vi.fn().mockResolvedValue({
  id: 'order_123',
  amount: 9900,
  currency: 'INR',
});

vi.mock('razorpay', () => {
  return {
    default: vi.fn().mockImplementation(() => ({
      orders: {
        create: mockCreate,
      },
    })),
  };
});

// ─── Env vars (before handler import) ──────────────────────────
vi.stubEnv('RAZORPAY_KEY_ID', 'test-key-id');
vi.stubEnv('RAZORPAY_KEY_SECRET', 'test-key-secret');

const { handler } = await import('../app.ts');

// ─── Helpers ───────────────────────────────────────────────────

function makeJwt(sub: string): string {
  const header = btoa(JSON.stringify({ alg: 'RS256' }));
  const payload = btoa(JSON.stringify({ sub }));
  return `${header}.${payload}.sig`;
}

function makeEvent(
  body: any,
  overrides: Partial<APIGatewayProxyEvent> = {},
): APIGatewayProxyEvent {
  return {
    httpMethod: 'POST',
    path: '/orders',
    resource: '/orders',
    headers: {
      authorization: `Bearer ${makeJwt('user-1')}`,
      ...((overrides as any).headers || {}),
    },
    multiValueHeaders: {},
    queryStringParameters: null,
    multiValueQueryStringParameters: null,
    pathParameters: null,
    stageVariables: null,
    requestContext: {
      accountId: '123',
      apiId: 'api',
      authorizer: null,
      protocol: 'HTTP/1.1',
      httpMethod: 'POST',
      identity: {
        accessKey: null, accountId: null, apiKey: null, apiKeyId: null,
        caller: null, clientCert: null, cognitoAuthenticationProvider: null,
        cognitoAuthenticationType: null, cognitoIdentityId: null,
        cognitoIdentityPoolId: null, principalOrgId: null, sourceIp: '127.0.0.1',
        user: null, userAgent: 'test', userArn: null,
      },
      path: '/orders',
      stage: 'test',
      requestId: 'req-1',
      requestTimeEpoch: 0,
      resourceId: 'res-1',
      resourcePath: '/orders',
    },
    body: body !== undefined ? JSON.stringify(body) : null,
    isBase64Encoded: false,
    ...overrides,
  } as unknown as APIGatewayProxyEvent;
}

// ─── Tests ─────────────────────────────────────────────────────

beforeEach(() => {
  mockCreate.mockClear();
  mockCreate.mockResolvedValue({
    id: 'order_123',
    amount: 9900,
    currency: 'INR',
  });
});

describe('create-order-razorpay handler', () => {
  // ── Success ────────────────────────────────────────────────

  it('creates a Razorpay order and returns 200', async () => {
    const res = await handler(makeEvent({ amount: 99 }), {} as any, () => {}) as any;

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(true);
    expect(body.data.orderId).toBe('order_123');
    expect(body.data.amount).toBe(9900);
    expect(body.data.currency).toBe('INR');

    // Verify Razorpay was called with amount in paise
    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        amount: 9900, // 99 * 100
        currency: 'INR',
      }),
    );
  });

  // ── Auth errors ────────────────────────────────────────────

  it('returns 401 when authorization header is missing', async () => {
    const event = makeEvent({ amount: 99 });
    event.headers = {};
    const res = await handler(event, {} as any, () => {}) as any;

    expect(res.statusCode).toBe(401);
    const body = JSON.parse(res.body);
    expect(body.errorCode).toBe('UNAUTHORIZED');
  });

  // ── Validation errors ──────────────────────────────────────

  it('returns 400 when amount is zero', async () => {
    const res = await handler(makeEvent({ amount: 0 }), {} as any, () => {}) as any;

    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.errorCode).toBe('VALIDATION_ERROR');
    expect(body.message).toContain('amount');
  });

  it('returns 400 when amount is negative', async () => {
    const res = await handler(makeEvent({ amount: -50 }), {} as any, () => {}) as any;

    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.errorCode).toBe('VALIDATION_ERROR');
  });

  it('returns 400 when body is missing (parses as empty object)', async () => {
    const event = makeEvent(undefined);
    event.body = null;
    const res = await handler(event, {} as any, () => {}) as any;

    // amount will be undefined, which is falsy => validation error
    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.errorCode).toBe('VALIDATION_ERROR');
  });

  // ── Razorpay / service errors ──────────────────────────────

  it('returns 500 when Razorpay order creation fails', async () => {
    mockCreate.mockRejectedValueOnce(new Error('Razorpay service unavailable'));

    const res = await handler(makeEvent({ amount: 99 }), {} as any, () => {}) as any;

    expect(res.statusCode).toBe(500);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(false);
    expect(body.errorCode).toBe('INTERNAL_ERROR');
  });
});
