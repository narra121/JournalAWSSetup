import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.stubEnv('USER_POOL_ID', 'us-east-1_t');
vi.stubEnv('USER_POOL_CLIENT_ID', 'c');
vi.stubEnv('ALLOWED_ORIGINS', 'https://dev.tradequt.com');
vi.stubEnv('IMAGES_BUCKET', 'images-bucket');

const signer = vi.fn();
vi.mock('@aws-sdk/s3-request-presigner', () => ({ getSignedUrl: (...a: any[]) => signer(...a) }));

const { createApp } = await import('../app');
const { setTokenVerifier } = await import('../auth/cognito');
const app = createApp();
const post = (body: unknown) =>
  app.request('/v1/uploads/images', { method: 'POST', headers: { authorization: 'Bearer good', 'content-type': 'application/json' }, body: typeof body === 'string' ? body : JSON.stringify(body) });

beforeEach(() => {
  signer.mockReset().mockResolvedValue('https://images-bucket.s3.amazonaws.com/signed');
  setTokenVerifier({ verify: async () => ({ sub: 'u1' }) });
});

describe('POST /v1/uploads/images', () => {
  it('returns a 5-minute presigned PUT under the caller prefix with Content-Type and Content-Length signed', async () => {
    const res = await post({ contentType: 'image/png', size: 2 * 1024 * 1024 });
    expect(res.status).toBe(200);
    const { data } = await res.json();
    expect(data.url).toContain('signed');
    expect(data.key).toMatch(/^images\/u1\/upload\/[0-9a-f-]{36}\.png$/);
    expect(data).toMatchObject({ method: 'PUT', headers: { 'Content-Type': 'image/png' }, expiresIn: 300, maxBytes: 2097152 });

    const [, command, options] = signer.mock.calls[0];
    expect(command.input).toMatchObject({ Bucket: 'images-bucket', Key: data.key, ContentType: 'image/png', ContentLength: 2097152 });
    expect(options.expiresIn).toBe(300);
    expect([...options.signableHeaders].sort()).toEqual(['content-length', 'content-type']);
  });

  it.each([['image/jpeg', 'jpg'], ['image/webp', 'webp']])('%s uses the .%s extension', async (contentType, ext) => {
    expect((await (await post({ contentType, size: 100 })).json()).data.key.endsWith(`.${ext}`)).toBe(true);
  });

  it.each([
    ['2.1 MiB', { contentType: 'image/png', size: 2 * 1024 * 1024 + 1 }],
    ['zero bytes', { contentType: 'image/png', size: 0 }],
    ['a fractional size', { contentType: 'image/png', size: 1.5 }],
    ['a missing size', { contentType: 'image/png' }],
    ['a gif', { contentType: 'image/gif', size: 100 }],
    ['an svg', { contentType: 'image/svg+xml', size: 100 }],
    ['no body', 'null'],
  ])('rejects %s with 400 and signs nothing', async (_n, body) => {
    expect((await post(body)).status).toBe(400);
    expect(signer).not.toHaveBeenCalled();
  });

  it('requires authentication', async () => {
    setTokenVerifier({ verify: async () => Promise.reject(new Error('bad')) });
    expect((await post({ contentType: 'image/png', size: 10 })).status).toBe(401);
  });
});
