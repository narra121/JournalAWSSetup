import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';
import type { APIGatewayProxyEventV2 } from 'aws-lambda';

// ─── Env ───────────────────────────────────────────────────────
vi.stubEnv('FIREBASE_SERVICE_ACCOUNT_PARAM', '/tradequt/firebase-service-account');

// ─── Firebase Admin mocks ──────────────────────────────────────
const mockCreateCustomToken = vi.fn();
const mockGetApps = vi.fn();
const mockInitializeApp = vi.fn();
const mockCert = vi.fn((key: any) => ({ ...key, type: 'cert' }));

vi.mock('firebase-admin/app', () => ({
  initializeApp: (...args: any[]) => mockInitializeApp(...args),
  cert: (...args: any[]) => mockCert(...args),
  getApps: () => mockGetApps(),
}));

vi.mock('firebase-admin/auth', () => ({
  getAuth: () => ({ createCustomToken: mockCreateCustomToken }),
}));

// ─── SSM mock ──────────────────────────────────────────────────
const ssmMock = mockClient(SSMClient);

// ─── Helpers ───────────────────────────────────────────────────
const FAKE_SA_KEY = JSON.stringify({
  type: 'service_account',
  project_id: 'test-project',
  private_key_id: 'key-123',
  private_key: '-----BEGIN RSA PRIVATE KEY-----\nfake\n-----END RSA PRIVATE KEY-----\n',
  client_email: 'test@test-project.iam.gserviceaccount.com',
});

function makeEvent(userId?: string): APIGatewayProxyEventV2 {
  return {
    version: '2.0',
    routeKey: 'POST /v1/auth/firebase-token',
    rawPath: '/v1/auth/firebase-token',
    rawQueryString: '',
    headers: {},
    requestContext: {
      accountId: '123',
      apiId: 'api',
      domainName: 'api.example.com',
      domainPrefix: 'api',
      http: { method: 'POST', path: '/v1/auth/firebase-token', protocol: 'HTTP/1.1', sourceIp: '127.0.0.1', userAgent: 'test' },
      requestId: 'req-1',
      routeKey: 'POST /v1/auth/firebase-token',
      stage: '$default',
      time: '01/Jan/2024:00:00:00 +0000',
      timeEpoch: 0,
      ...(userId
        ? { authorizer: { jwt: { claims: { sub: userId }, scopes: [] } } }
        : {}),
    },
    body: undefined,
    isBase64Encoded: false,
  } as unknown as APIGatewayProxyEventV2;
}

// ─── Tests ─────────────────────────────────────────────────────

// Each test re-imports the handler to get a fresh module with a clean cachedSaKey.
async function freshHandler() {
  vi.resetModules();
  // Re-register mocks after resetModules
  vi.doMock('firebase-admin/app', () => ({
    initializeApp: (...args: any[]) => mockInitializeApp(...args),
    cert: (...args: any[]) => mockCert(...args),
    getApps: () => mockGetApps(),
  }));
  vi.doMock('firebase-admin/auth', () => ({
    getAuth: () => ({ createCustomToken: mockCreateCustomToken }),
  }));
  const mod = await import('../app');
  return mod.handler;
}

beforeEach(() => {
  ssmMock.reset();
  mockCreateCustomToken.mockReset();
  mockGetApps.mockReset();
  mockInitializeApp.mockReset();
  mockCert.mockReset();
  mockCert.mockImplementation((key: any) => ({ ...key, type: 'cert' }));
  // Default: no Firebase app initialized yet
  mockGetApps.mockReturnValue([]);
});

describe('firebase-token handler', () => {
  it('returns firebaseToken for authenticated user', async () => {
    const handler = await freshHandler();
    ssmMock.on(GetParameterCommand).resolves({
      Parameter: { Value: FAKE_SA_KEY },
    });
    mockCreateCustomToken.mockResolvedValue('firebase-custom-token-123');

    const res = await handler(makeEvent('user-abc-123'), {} as any, () => {}) as any;

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(true);
    expect(body.data.firebaseToken).toBe('firebase-custom-token-123');
    expect(body.message).toBe('Firebase token created');
  });

  it('passes userId to createCustomToken', async () => {
    const handler = await freshHandler();
    ssmMock.on(GetParameterCommand).resolves({
      Parameter: { Value: FAKE_SA_KEY },
    });
    mockCreateCustomToken.mockResolvedValue('token');

    await handler(makeEvent('specific-user-id'), {} as any, () => {});

    expect(mockCreateCustomToken).toHaveBeenCalledWith('specific-user-id');
  });

  it('returns 401 for unauthenticated request', async () => {
    const handler = await freshHandler();
    const res = await handler(makeEvent(), {} as any, () => {}) as any;

    expect(res.statusCode).toBe(401);
    const body = JSON.parse(res.body);
    expect(body.errorCode).toBe('UNAUTHORIZED');
  });

  it('caches SSM parameter (only 1 SSM call for multiple invocations)', async () => {
    const handler = await freshHandler();
    ssmMock.on(GetParameterCommand).resolves({
      Parameter: { Value: FAKE_SA_KEY },
    });
    mockCreateCustomToken.mockResolvedValue('token-1');

    // First invocation
    await handler(makeEvent('user-1'), {} as any, () => {});
    // Second invocation — Firebase app now exists
    mockCreateCustomToken.mockResolvedValue('token-2');
    mockGetApps.mockReturnValue([{ name: '[DEFAULT]' }]);
    await handler(makeEvent('user-2'), {} as any, () => {});

    const ssmCalls = ssmMock.commandCalls(GetParameterCommand);
    expect(ssmCalls).toHaveLength(1);
  });

  it('returns 500 when SSM parameter is missing', async () => {
    const handler = await freshHandler();
    ssmMock.on(GetParameterCommand).resolves({
      Parameter: { Value: undefined },
    });

    const res = await handler(makeEvent('user-1'), {} as any, () => {}) as any;

    expect(res.statusCode).toBe(500);
    const body = JSON.parse(res.body);
    expect(body.errorCode).toBe('INTERNAL_ERROR');
  });

  it('returns 500 when Firebase Admin SDK fails', async () => {
    const handler = await freshHandler();
    ssmMock.on(GetParameterCommand).resolves({
      Parameter: { Value: FAKE_SA_KEY },
    });
    mockCreateCustomToken.mockRejectedValue(new Error('Firebase Admin error'));

    const res = await handler(makeEvent('user-1'), {} as any, () => {}) as any;

    expect(res.statusCode).toBe(500);
    const body = JSON.parse(res.body);
    expect(body.errorCode).toBe('INTERNAL_ERROR');
    expect(body.message).toBe('Failed to create Firebase token');
  });

  it('returns 500 when SSM call fails', async () => {
    const handler = await freshHandler();
    ssmMock.on(GetParameterCommand).rejects(new Error('SSM timeout'));

    const res = await handler(makeEvent('user-1'), {} as any, () => {}) as any;

    expect(res.statusCode).toBe(500);
    const body = JSON.parse(res.body);
    expect(body.errorCode).toBe('INTERNAL_ERROR');
  });

  it('skips initializeApp when Firebase app already exists', async () => {
    const handler = await freshHandler();
    mockGetApps.mockReturnValue([{ name: '[DEFAULT]' }]);
    ssmMock.on(GetParameterCommand).resolves({
      Parameter: { Value: FAKE_SA_KEY },
    });
    mockCreateCustomToken.mockResolvedValue('token');

    await handler(makeEvent('user-1'), {} as any, () => {});

    expect(mockInitializeApp).not.toHaveBeenCalled();
  });

  it('calls initializeApp when no Firebase app exists', async () => {
    const handler = await freshHandler();
    mockGetApps.mockReturnValue([]);
    ssmMock.on(GetParameterCommand).resolves({
      Parameter: { Value: FAKE_SA_KEY },
    });
    mockCreateCustomToken.mockResolvedValue('token');

    await handler(makeEvent('user-1'), {} as any, () => {});

    expect(mockInitializeApp).toHaveBeenCalledTimes(1);
  });

  it('calls SSM with WithDecryption: true', async () => {
    const handler = await freshHandler();
    ssmMock.on(GetParameterCommand).resolves({
      Parameter: { Value: FAKE_SA_KEY },
    });
    mockCreateCustomToken.mockResolvedValue('token');

    await handler(makeEvent('user-1'), {} as any, () => {});

    const calls = ssmMock.commandCalls(GetParameterCommand);
    expect(calls).toHaveLength(1);
    expect(calls[0].args[0].input.WithDecryption).toBe(true);
    expect(calls[0].args[0].input.Name).toBe('/tradequt/firebase-service-account');
  });
});
