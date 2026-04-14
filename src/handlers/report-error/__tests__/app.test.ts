import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { DynamoDBDocumentClient, GetCommand, PutCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import type { APIGatewayProxyEventV2 } from 'aws-lambda';

vi.stubEnv('ERROR_REPORTS_BUCKET', 'test-error-bucket');
vi.stubEnv('RATE_LIMIT_TABLE', 'test-rate-limit');

const s3Mock = mockClient(S3Client);
const ddbMock = mockClient(DynamoDBDocumentClient);

const { handler } = await import('../app.ts');

// ─── Helpers ────────────────────────────────────────────────────

function validPayload() {
  return {
    error: { message: 'Something went wrong', type: 'unhandled-error' },
    timestamp: new Date().toISOString(),
    url: 'https://tradequt.com/dashboard',
  };
}

function makeEvent(body?: any, overrides: Partial<APIGatewayProxyEventV2> = {}): APIGatewayProxyEventV2 {
  return {
    version: '2.0',
    routeKey: 'POST /v1/errors/report',
    rawPath: '/v1/errors/report',
    rawQueryString: '',
    headers: {},
    requestContext: {
      accountId: '123',
      apiId: 'api',
      domainName: 'api.example.com',
      domainPrefix: 'api',
      http: { method: 'POST', path: '/v1/errors/report', protocol: 'HTTP/1.1', sourceIp: '127.0.0.1', userAgent: 'test' },
      requestId: 'req-1',
      routeKey: 'POST /v1/errors/report',
      stage: '$default',
      time: '01/Jan/2024:00:00:00 +0000',
      timeEpoch: 0,
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
    isBase64Encoded: false,
    ...overrides,
  } as unknown as APIGatewayProxyEventV2;
}

function makeAuthEvent(body: any, userId: string): APIGatewayProxyEventV2 {
  // Create a simple JWT with the given userId as sub
  const header = btoa(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const payload = btoa(JSON.stringify({ sub: userId, iss: 'test' }));
  const signature = 'fake-sig';
  const token = `${header}.${payload}.${signature}`;

  return {
    ...makeEvent(body),
    headers: { authorization: `Bearer ${token}` },
  } as unknown as APIGatewayProxyEventV2;
}

// ─── Tests ──────────────────────────────────────────────────────

beforeEach(() => {
  s3Mock.reset();
  ddbMock.reset();
  // Rate limit defaults: allow (atomic UpdateCommand returns count=1, ttl in future)
  ddbMock.on(UpdateCommand).resolves({
    Attributes: { key: 'error-report:127.0.0.1', count: 1, ttl: Math.floor(Date.now() / 1000) + 3600 },
  });
  ddbMock.on(GetCommand).resolves({ Item: undefined });
  ddbMock.on(PutCommand).resolves({});
  // S3 defaults: success
  s3Mock.on(PutObjectCommand).resolves({});
});

describe('report-error handler', () => {
  // ── 1. Success ────────────────────────────────────────────────

  it('returns 202 for valid error report', async () => {
    const res = await handler(makeEvent(validPayload()), {} as any, () => {}) as any;

    expect(res.statusCode).toBe(202);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(true);
    expect(body.message).toBe('Error report received');

    // Verify S3 PutObject was called
    const calls = s3Mock.commandCalls(PutObjectCommand);
    expect(calls).toHaveLength(1);
    expect(calls[0].args[0].input.Bucket).toBe('test-error-bucket');
    expect(calls[0].args[0].input.ContentType).toBe('application/json');
    expect(calls[0].args[0].input.Key).toMatch(/^errors\/\d{4}-\d{2}-\d{2}\/anonymous\//);
  });

  // ── 2. Missing body ──────────────────────────────────────────

  it('returns 400 for missing body', async () => {
    const event = makeEvent(undefined);
    event.body = undefined;
    const res = await handler(event, {} as any, () => {}) as any;

    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.errorCode).toBe('VALIDATION_ERROR');
    expect(body.message).toContain('Missing body');
  });

  // ── 3. Invalid JSON ──────────────────────────────────────────

  it('returns 400 for invalid JSON', async () => {
    const event = makeEvent(validPayload());
    event.body = '{not-valid-json';
    const res = await handler(event, {} as any, () => {}) as any;

    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.errorCode).toBe('VALIDATION_ERROR');
    expect(body.message).toContain('Invalid JSON');
  });

  // ── 4. Payload too large ─────────────────────────────────────

  it('returns 413 for payload exceeding 1MB', async () => {
    const event = makeEvent(validPayload());
    // Create a body larger than 1MB
    event.body = 'x'.repeat(1025 * 1024);
    const res = await handler(event, {} as any, () => {}) as any;

    expect(res.statusCode).toBe(413);
    const body = JSON.parse(res.body);
    expect(body.errorCode).toBe('VALIDATION_ERROR');
    expect(body.message).toContain('Payload too large');
  });

  // ── 5. Rate limited ──────────────────────────────────────────

  it('returns 429 when rate limited', async () => {
    // Atomic UpdateCommand returns count exceeding limit (11 > 10)
    ddbMock.on(UpdateCommand).resolves({
      Attributes: { key: 'error-report:127.0.0.1', count: 11, ttl: Math.floor(Date.now() / 1000) + 3600 },
    });

    const res = await handler(makeEvent(validPayload()), {} as any, () => {}) as any;

    expect(res.statusCode).toBe(429);
    const body = JSON.parse(res.body);
    expect(body.message).toContain('Rate limit exceeded');
  });

  // ── 6. S3 failure returns 202 ────────────────────────────────

  it('returns 202 even when S3 write fails', async () => {
    s3Mock.on(PutObjectCommand).rejects(new Error('S3 error'));

    const res = await handler(makeEvent(validPayload()), {} as any, () => {}) as any;

    expect(res.statusCode).toBe(202);
    const body = JSON.parse(res.body);
    expect(body.message).toBe('Error report received');
  });

  // ── 7. Authenticated user ────────────────────────────────────

  it('uses userId from JWT when authenticated', async () => {
    const userId = 'user-abc-123';
    const res = await handler(makeAuthEvent(validPayload(), userId), {} as any, () => {}) as any;

    expect(res.statusCode).toBe(202);

    const calls = s3Mock.commandCalls(PutObjectCommand);
    expect(calls).toHaveLength(1);
    expect(calls[0].args[0].input.Key).toContain(`/${userId}/`);
  });

  // ── 8. Anonymous user ────────────────────────────────────────

  it('uses anonymous when not authenticated', async () => {
    const res = await handler(makeEvent(validPayload()), {} as any, () => {}) as any;

    expect(res.statusCode).toBe(202);

    const calls = s3Mock.commandCalls(PutObjectCommand);
    expect(calls).toHaveLength(1);
    expect(calls[0].args[0].input.Key).toContain('/anonymous/');
  });

  // ── 9. S3 key pattern ────────────────────────────────────────

  it('S3 key follows expected pattern', async () => {
    const res = await handler(makeEvent(validPayload()), {} as any, () => {}) as any;

    expect(res.statusCode).toBe(202);

    const calls = s3Mock.commandCalls(PutObjectCommand);
    expect(calls).toHaveLength(1);
    const key = calls[0].args[0].input.Key!;
    // Pattern: errors/{date}/{userId}/{timestamp}-{hash}.json
    expect(key).toMatch(/^errors\/\d{4}-\d{2}-\d{2}\/[^/]+\/\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-[a-f0-9]{8}\.json$/);
  });

  // ── 10. Schema validation ─────────────────────────────────────

  it('returns 400 for invalid schema (missing required field)', async () => {
    const res = await handler(makeEvent({ error: { message: 'test' } }), {} as any, () => {}) as any;

    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.errorCode).toBe('VALIDATION_ERROR');
    expect(body.message).toContain('Invalid error report');
  });
});
