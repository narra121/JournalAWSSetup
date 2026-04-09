import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import type { APIGatewayProxyEvent } from 'aws-lambda';
import { Readable } from 'stream';

// Stub env before importing handler
vi.stubEnv('IMAGES_BUCKET', 'test-images-bucket');

// Mock S3
const s3Mock = mockClient(S3Client);

const { handler } = await import('../app.ts');

// ─── Helpers ────────────────────────────────────────────────────

function makeEvent(
  imageId?: string,
  overrides: Partial<APIGatewayProxyEvent> = {},
): APIGatewayProxyEvent {
  return {
    httpMethod: 'GET',
    path: `/images/${imageId || ''}`,
    headers: {
      authorization: 'Bearer valid-jwt-token',
    },
    pathParameters: imageId !== undefined ? { imageId } : null,
    queryStringParameters: null,
    multiValueQueryStringParameters: null,
    multiValueHeaders: {},
    stageVariables: null,
    requestContext: {
      accountId: '123',
      apiId: 'api',
      authorizer: {},
      protocol: 'HTTP/1.1',
      httpMethod: 'GET',
      identity: {
        accessKey: null,
        accountId: null,
        apiKey: null,
        apiKeyId: null,
        caller: null,
        clientCert: null,
        cognitoAuthenticationProvider: null,
        cognitoAuthenticationType: null,
        cognitoIdentityId: null,
        cognitoIdentityPoolId: null,
        principalOrgId: null,
        sourceIp: '127.0.0.1',
        user: null,
        userAgent: 'test',
        userArn: null,
      },
      path: `/images/${imageId || ''}`,
      stage: 'test',
      requestId: 'req-1',
      requestTimeEpoch: 0,
      resourceId: 'res',
      resourcePath: '/images/{imageId+}',
    },
    resource: '/images/{imageId+}',
    body: null,
    isBase64Encoded: false,
    ...overrides,
  } as unknown as APIGatewayProxyEvent;
}

function createReadableStream(data: string): Readable {
  const readable = new Readable();
  readable.push(Buffer.from(data));
  readable.push(null);
  return readable;
}

// ─── Tests ──────────────────────────────────────────────────────

beforeEach(() => {
  s3Mock.reset();
});

describe('get-image handler', () => {
  // ── Success ─────────────────────────────────────────────────

  it('returns 200 with base64-encoded image body', async () => {
    const imageData = 'fake-image-binary-data';
    s3Mock.on(GetObjectCommand).resolves({
      Body: createReadableStream(imageData) as any,
      ContentType: 'image/jpeg',
    });

    const res = await handler(makeEvent('acc1/trade1/photo.jpg'), {} as any, () => {}) as any;

    expect(res.statusCode).toBe(200);
    expect(res.isBase64Encoded).toBe(true);
    expect(res.body).toBe(Buffer.from(imageData).toString('base64'));
    expect(res.headers['Content-Type']).toBe('image/jpeg');
    expect(res.headers['X-Content-Type-Options']).toBe('nosniff');
    expect(res.headers['X-Frame-Options']).toBe('DENY');
  });

  // ── Auth errors ─────────────────────────────────────────────

  it('returns 401 when authorization header is missing', async () => {
    const event = makeEvent('acc1/trade1/photo.jpg', { headers: {} });
    const res = await handler(event, {} as any, () => {}) as any;

    expect(res.statusCode).toBe(401);
    const body = JSON.parse(res.body);
    expect(body.error).toContain('Unauthorized');
  });

  it('returns 401 when authorization header has no Bearer prefix', async () => {
    const event = makeEvent('acc1/trade1/photo.jpg', {
      headers: { authorization: 'Basic abc123' },
    });
    const res = await handler(event, {} as any, () => {}) as any;

    expect(res.statusCode).toBe(401);
  });

  // ── Validation errors ───────────────────────────────────────

  it('returns 400 when imageId path param is missing', async () => {
    const event = makeEvent(undefined);
    event.pathParameters = null;
    const res = await handler(event, {} as any, () => {}) as any;

    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.error).toContain('imageId is required');
  });

  it('returns 400 for invalid image extension', async () => {
    const res = await handler(
      makeEvent('acc1/trade1/file.bmp'),
      {} as any,
      () => {},
    ) as any;

    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.error).toContain('Invalid image format');
  });

  it('returns 400 for path traversal with ..', async () => {
    const res = await handler(
      makeEvent('acc1/../secret/photo.jpg'),
      {} as any,
      () => {},
    ) as any;

    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.error).toContain('Invalid image ID format');
  });

  it('returns 400 for path traversal with backslash', async () => {
    const res = await handler(
      makeEvent('acc1\\trade1\\photo.jpg'),
      {} as any,
      () => {},
    ) as any;

    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.error).toContain('Invalid image ID format');
  });

  it('returns 400 when path has too few parts', async () => {
    const res = await handler(
      makeEvent('acc1/photo.jpg'),
      {} as any,
      () => {},
    ) as any;

    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.error).toContain('Expected: accountId/tradeId/filename');
  });

  it('returns 400 when path has too many parts', async () => {
    const res = await handler(
      makeEvent('acc1/trade1/sub/photo.jpg'),
      {} as any,
      () => {},
    ) as any;

    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.error).toContain('Expected: accountId/tradeId/filename');
  });

  // ── S3 errors ───────────────────────────────────────────────

  it('returns 404 when S3 returns NoSuchKey', async () => {
    const error = new Error('The specified key does not exist.');
    (error as any).name = 'NoSuchKey';
    s3Mock.on(GetObjectCommand).rejects(error);

    const res = await handler(
      makeEvent('acc1/trade1/missing.jpg'),
      {} as any,
      () => {},
    ) as any;

    expect(res.statusCode).toBe(404);
    const body = JSON.parse(res.body);
    expect(body.error).toContain('Image not found');
  });

  it('returns 500 when IMAGES_BUCKET env is missing', async () => {
    // Temporarily remove the env var
    const original = process.env.IMAGES_BUCKET;
    delete process.env.IMAGES_BUCKET;

    const res = await handler(
      makeEvent('acc1/trade1/photo.jpg'),
      {} as any,
      () => {},
    ) as any;

    // Restore
    process.env.IMAGES_BUCKET = original;

    expect(res.statusCode).toBe(500);
    const body = JSON.parse(res.body);
    expect(body.error).toContain('Server configuration error');
  });

  it('returns 500 when S3 returns unexpected error', async () => {
    s3Mock.on(GetObjectCommand).rejects(new Error('S3 internal error'));

    const res = await handler(
      makeEvent('acc1/trade1/photo.jpg'),
      {} as any,
      () => {},
    ) as any;

    expect(res.statusCode).toBe(500);
    const body = JSON.parse(res.body);
    expect(body.error).toContain('Failed to retrieve image');
  });
});
