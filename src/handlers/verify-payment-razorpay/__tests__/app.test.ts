import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBDocumentClient, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import crypto from 'crypto';
import type { APIGatewayProxyEvent } from 'aws-lambda';

// ─── Env vars (before handler import) ──────────────────────────
vi.stubEnv('RAZORPAY_KEY_SECRET', 'test-key-secret');
vi.stubEnv('SUBSCRIPTIONS_TABLE', 'test-subscriptions');

const ddbMock = mockClient(DynamoDBDocumentClient);

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
    path: '/verify-payment',
    resource: '/verify-payment',
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
      path: '/verify-payment',
      stage: 'test',
      requestId: 'req-1',
      requestTimeEpoch: 0,
      resourceId: 'res-1',
      resourcePath: '/verify-payment',
    },
    body: body !== undefined ? JSON.stringify(body) : null,
    isBase64Encoded: false,
    ...overrides,
  } as unknown as APIGatewayProxyEvent;
}

// Compute a valid HMAC signature for test data
const validSignature = crypto
  .createHmac('sha256', 'test-key-secret')
  .update('order_123|payment_123')
  .digest('hex');

const validPayload = {
  razorpay_order_id: 'order_123',
  razorpay_payment_id: 'payment_123',
  razorpay_signature: validSignature,
};

// ─── Tests ─────────────────────────────────────────────────────

beforeEach(() => {
  ddbMock.reset();
  ddbMock.on(UpdateCommand).resolves({});
});

describe('verify-payment-razorpay handler', () => {
  // ── Success ────────────────────────────────────────────────

  it('returns 200 with verified true when signature is valid', async () => {
    const res = await handler(makeEvent(validPayload), {} as any, () => {}) as any;

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.data.verified).toBe(true);
    expect(body.data.paymentId).toBe('payment_123');
    expect(body.data.orderId).toBe('order_123');

    // Verify DynamoDB was called to update subscription
    const calls = ddbMock.commandCalls(UpdateCommand);
    expect(calls).toHaveLength(1);
    expect(calls[0].args[0].input.TableName).toBe('test-subscriptions');
    expect(calls[0].args[0].input.Key).toEqual({ userId: 'user-1' });
  });

  // ── Missing fields ────────────────────────────────────────

  it('returns 400 when razorpay_order_id is missing', async () => {
    const payload = { ...validPayload, razorpay_order_id: undefined };
    const res = await handler(makeEvent(payload), {} as any, () => {}) as any;

    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.error.code).toBe('INVALID_REQUEST');
    expect(body.error.message).toContain('Missing required');
  });

  it('returns 400 when razorpay_payment_id is missing', async () => {
    const payload = { ...validPayload, razorpay_payment_id: undefined };
    const res = await handler(makeEvent(payload), {} as any, () => {}) as any;

    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.error.code).toBe('INVALID_REQUEST');
  });

  it('returns 400 when razorpay_signature is missing', async () => {
    const payload = { ...validPayload, razorpay_signature: undefined };
    const res = await handler(makeEvent(payload), {} as any, () => {}) as any;

    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.error.code).toBe('INVALID_REQUEST');
  });

  // ── Auth errors ────────────────────────────────────────────

  it('returns 401 when authorization header is missing', async () => {
    const event = makeEvent(validPayload);
    event.headers = {};
    const res = await handler(event, {} as any, () => {}) as any;

    expect(res.statusCode).toBe(401);
    const body = JSON.parse(res.body);
    expect(body.error.code).toBe('UNAUTHORIZED');
  });

  // ── Invalid signature ──────────────────────────────────────

  it('returns 400 with VERIFICATION_FAILED when signature is invalid', async () => {
    const payload = { ...validPayload, razorpay_signature: 'invalid-hex-signature' };
    const res = await handler(makeEvent(payload), {} as any, () => {}) as any;

    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.error.code).toBe('VERIFICATION_FAILED');
    expect(body.error.message).toContain('verification failed');
  });

  // ── DynamoDB errors ────────────────────────────────────────

  it('returns 500 when DynamoDB update fails', async () => {
    ddbMock.on(UpdateCommand).rejects(new Error('DynamoDB write error'));

    const res = await handler(makeEvent(validPayload), {} as any, () => {}) as any;

    expect(res.statusCode).toBe(500);
    const body = JSON.parse(res.body);
    expect(body.error.code).toBe('INTERNAL_ERROR');
    expect(body.error.message).toContain('Failed to verify payment');
  });
});
