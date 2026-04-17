import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';
import { DynamoDBDocumentClient, GetCommand } from '@aws-sdk/lib-dynamodb';
import type { APIGatewayProxyEventV2 } from 'aws-lambda';

// Mock environment variables before importing handler
vi.stubEnv('SUBSCRIPTIONS_TABLE', 'test-subscriptions');
vi.stubEnv('AD_CONFIG_PARAM', '/tradequt/dev/adConfig');

const ssmMock = mockClient(SSMClient);
const ddbMock = mockClient(DynamoDBDocumentClient);

const { handler, _clearAdConfigCache } = await import('../app');

// ─── Helpers ─────────────────────────────────────────────────────

function makeEvent(overrides: Partial<APIGatewayProxyEventV2> = {}): APIGatewayProxyEventV2 {
  return {
    version: '2.0',
    routeKey: 'GET /v1/ad-config',
    rawPath: '/v1/ad-config',
    rawQueryString: '',
    headers: {},
    requestContext: {
      accountId: '123',
      apiId: 'api',
      domainName: 'api.example.com',
      domainPrefix: 'api',
      http: { method: 'GET', path: '/v1/ad-config', protocol: 'HTTP/1.1', sourceIp: '127.0.0.1', userAgent: 'test' },
      requestId: 'req-1',
      routeKey: 'GET /v1/ad-config',
      stage: '$default',
      time: '01/Jan/2024:00:00:00 +0000',
      timeEpoch: 0,
      authorizer: {
        jwt: {
          claims: { sub: 'user-1' },
          scopes: [],
        },
      },
    },
    body: undefined,
    isBase64Encoded: false,
    ...overrides,
  } as unknown as APIGatewayProxyEventV2;
}

const AD_CONFIG_SSM_VALUE = JSON.stringify({
  provider: 'google_adsense',
  clientId: 'ca-pub-1234567890',
  placements: [
    { id: 'dashboard-bottom', slotId: '1234567890', format: 'auto', enabled: true },
  ],
});

// ─── Tests ───────────────────────────────────────────────────────

beforeEach(() => {
  ssmMock.reset();
  ddbMock.reset();
  _clearAdConfigCache();
});

describe('get-ad-config handler', () => {
  // ── 1. Returns showAds: false for paid users ──

  it('returns showAds: false for paid users', async () => {
    ddbMock.on(GetCommand).resolves({
      Item: { userId: 'user-1', status: 'active' },
    });

    const res = await handler(makeEvent(), {} as any, () => {}) as any;

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(true);
    expect(body.data.showAds).toBe(false);
    expect(body.data.tier).toBe('paid');
    expect(body.data.placements).toEqual([]);
  });

  // ── 2. Returns showAds: false for trial users ──

  it('returns showAds: false for trial users', async () => {
    const futureDate = new Date(Date.now() + 86400000 * 7).toISOString();
    ddbMock.on(GetCommand).resolves({
      Item: { userId: 'user-1', status: 'trial', trialEnd: futureDate },
    });

    const res = await handler(makeEvent(), {} as any, () => {}) as any;

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.data.showAds).toBe(false);
    expect(body.data.tier).toBe('trial');
    expect(body.data.placements).toEqual([]);
  });

  // ── 3. Returns full config for free_with_ads users ──

  it('returns full config for free_with_ads users', async () => {
    ddbMock.on(GetCommand).resolves({ Item: undefined }); // No subscription
    ssmMock.on(GetParameterCommand).resolves({
      Parameter: { Value: AD_CONFIG_SSM_VALUE },
    });

    const res = await handler(makeEvent(), {} as any, () => {}) as any;

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.data.showAds).toBe(true);
    expect(body.data.tier).toBe('free_with_ads');
    expect(body.data.provider).toBe('google_adsense');
    expect(body.data.clientId).toBe('ca-pub-1234567890');
    expect(body.data.placements).toHaveLength(1);
    expect(body.data.placements[0].id).toBe('dashboard-bottom');
  });

  // ── 4. Returns 401 for unauthenticated requests ──

  it('returns 401 for unauthenticated requests', async () => {
    const event = makeEvent({
      requestContext: {
        accountId: '123',
        apiId: 'api',
        domainName: 'api.example.com',
        domainPrefix: 'api',
        http: { method: 'GET', path: '/v1/ad-config', protocol: 'HTTP/1.1', sourceIp: '127.0.0.1', userAgent: 'test' },
        requestId: 'req-1',
        routeKey: 'GET /v1/ad-config',
        stage: '$default',
        time: '01/Jan/2024:00:00:00 +0000',
        timeEpoch: 0,
        // No authorizer
      },
    } as any);

    const res = await handler(event, {} as any, () => {}) as any;

    expect(res.statusCode).toBe(401);
    const body = JSON.parse(res.body);
    expect(body.errorCode).toBe('UNAUTHORIZED');
  });

  // ── 5. Caches SSM responses ──

  it('caches SSM responses across calls', async () => {
    ddbMock.on(GetCommand).resolves({ Item: undefined }); // free_with_ads
    ssmMock.on(GetParameterCommand).resolves({
      Parameter: { Value: AD_CONFIG_SSM_VALUE },
    });

    // First call — should hit SSM
    const res1 = await handler(makeEvent(), {} as any, () => {}) as any;
    expect(res1.statusCode).toBe(200);

    // Second call — should use cache (SSM mock already consumed)
    const res2 = await handler(makeEvent(), {} as any, () => {}) as any;
    expect(res2.statusCode).toBe(200);

    const body2 = JSON.parse(res2.body);
    expect(body2.data.showAds).toBe(true);
    expect(body2.data.placements).toHaveLength(1);

    // SSM should only have been called once
    expect(ssmMock.commandCalls(GetParameterCommand)).toHaveLength(1);
  });

  // ── 6. Returns empty placements when AD_CONFIG_PARAM is not set ──

  it('returns empty placements when AD_CONFIG_PARAM is not set', async () => {
    // Temporarily clear the env var
    const origParam = process.env.AD_CONFIG_PARAM;
    delete process.env.AD_CONFIG_PARAM;

    ddbMock.on(GetCommand).resolves({ Item: undefined }); // free_with_ads

    const res = await handler(makeEvent(), {} as any, () => {}) as any;

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.data.showAds).toBe(true);
    expect(body.data.placements).toEqual([]);

    // Restore
    process.env.AD_CONFIG_PARAM = origParam;
  });

  // ── 7. Returns full config for expired trial users ──

  it('returns full config for expired trial users', async () => {
    const pastDate = new Date(Date.now() - 86400000).toISOString();
    ddbMock.on(GetCommand).resolves({
      Item: { userId: 'user-1', status: 'trial', trialEnd: pastDate },
    });
    ssmMock.on(GetParameterCommand).resolves({
      Parameter: { Value: AD_CONFIG_SSM_VALUE },
    });

    const res = await handler(makeEvent(), {} as any, () => {}) as any;

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.data.showAds).toBe(true);
    expect(body.data.tier).toBe('free_with_ads');
    expect(body.data.placements).toHaveLength(1);
  });

  // ── 8. Returns showAds: false for cancellation_requested within period ──

  it('returns showAds: false for cancellation_requested within period', async () => {
    const futureDate = new Date(Date.now() + 86400000 * 15).toISOString();
    ddbMock.on(GetCommand).resolves({
      Item: { userId: 'user-1', status: 'cancellation_requested', currentEnd: futureDate },
    });

    const res = await handler(makeEvent(), {} as any, () => {}) as any;

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.data.showAds).toBe(false);
    expect(body.data.tier).toBe('paid');
  });
});
