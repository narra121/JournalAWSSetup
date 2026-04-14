import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';
import type { APIGatewayProxyEventV2 } from 'aws-lambda';

// Mock environment variables before importing handler
vi.stubEnv('STAGE_NAME', 'test');

const ssmMock = mockClient(SSMClient);

const { handler, _clearSSMCache } = await import('../app.ts');

// ─── Helpers ─────────────────────────────────────────────────────

function makeEvent(
  queryParams?: Record<string, string>,
  overrides: Partial<APIGatewayProxyEventV2> = {},
): APIGatewayProxyEventV2 {
  return {
    version: '2.0',
    routeKey: 'GET /subscription-plans',
    rawPath: '/subscription-plans',
    rawQueryString: queryParams ? new URLSearchParams(queryParams).toString() : '',
    headers: {},
    queryStringParameters: queryParams || undefined,
    requestContext: {
      accountId: '123',
      apiId: 'api',
      domainName: 'api.example.com',
      domainPrefix: 'api',
      http: { method: 'GET', path: '/subscription-plans', protocol: 'HTTP/1.1', sourceIp: '127.0.0.1', userAgent: 'test' },
      requestId: 'req-1',
      routeKey: 'GET /subscription-plans',
      stage: '$default',
      time: '01/Jan/2024:00:00:00 +0000',
      timeEpoch: 0,
    },
    body: undefined,
    isBase64Encoded: false,
    ...overrides,
  } as unknown as APIGatewayProxyEventV2;
}

function mockSSMPrices(currency: 'usd' | 'inr') {
  ssmMock
    .on(GetParameterCommand, { Name: `/tradequt/test/stripe/price/monthly_${currency}` })
    .resolves({ Parameter: { Value: `price_test_monthly_${currency}` } });
  ssmMock
    .on(GetParameterCommand, { Name: `/tradequt/test/stripe/price/yearly_${currency}` })
    .resolves({ Parameter: { Value: `price_test_yearly_${currency}` } });
}

// ─── Tests ───────────────────────────────────────────────────────

beforeEach(() => {
  ssmMock.reset();
  _clearSSMCache();
});

describe('get-subscription-plans handler', () => {
  // ── 1. Returns monthly + yearly plans for USD (default) ────────

  it('returns monthly and yearly plans for USD (default)', async () => {
    mockSSMPrices('usd');

    const res = await handler(makeEvent()) as any;

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(true);
    expect(body.data.currency).toBe('USD');
    expect(body.data.plans).toHaveLength(2);

    const monthly = body.data.plans.find((p: any) => p.period === 'monthly');
    const yearly = body.data.plans.find((p: any) => p.period === 'yearly');

    expect(monthly).toBeDefined();
    expect(monthly.planId).toBe('price_test_monthly_usd');
    expect(yearly).toBeDefined();
    expect(yearly.planId).toBe('price_test_yearly_usd');
  });

  // ── 2. Returns monthly + yearly plans for INR when ?currency=INR ──

  it('returns monthly and yearly plans for INR when ?currency=INR', async () => {
    mockSSMPrices('inr');

    const res = await handler(makeEvent({ currency: 'INR' })) as any;

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.data.currency).toBe('INR');
    expect(body.data.plans).toHaveLength(2);

    const monthly = body.data.plans.find((p: any) => p.period === 'monthly');
    const yearly = body.data.plans.find((p: any) => p.period === 'yearly');

    expect(monthly).toBeDefined();
    expect(monthly.planId).toBe('price_test_monthly_inr');
    expect(yearly).toBeDefined();
    expect(yearly.planId).toBe('price_test_yearly_inr');
  });

  // ── 3. Returns 400 for invalid currency ────────────────────────

  it('returns 400 for invalid currency', async () => {
    const res = await handler(makeEvent({ currency: 'EUR' })) as any;

    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.errorCode).toBe('VALIDATION_ERROR');
    expect(body.message).toContain('Invalid currency');
  });

  // ── 4. Returns empty plans array when SSM params not found (ParameterNotFound) ──

  it('returns empty plans array when SSM params not found', async () => {
    const paramNotFound = new Error('Parameter not found');
    (paramNotFound as any).name = 'ParameterNotFound';
    ssmMock.on(GetParameterCommand).rejects(paramNotFound);

    const res = await handler(makeEvent()) as any;

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(true);
    expect(body.data.plans).toEqual([]);
  });

  // ── 5. Returns correct amounts: USD $1.99/$19.99, INR 99/999 ──

  it('returns correct amounts for USD: $1.99 monthly, $19.99 yearly', async () => {
    mockSSMPrices('usd');

    const res = await handler(makeEvent()) as any;

    const body = JSON.parse(res.body);
    const monthly = body.data.plans.find((p: any) => p.period === 'monthly');
    const yearly = body.data.plans.find((p: any) => p.period === 'yearly');

    // USD amounts are stored in cents (199, 1999) but displayed as dollars
    expect(monthly.amount).toBe(1.99);
    expect(yearly.amount).toBe(19.99);
  });

  it('returns correct amounts for INR: 99 monthly, 999 yearly', async () => {
    mockSSMPrices('inr');

    const res = await handler(makeEvent({ currency: 'INR' })) as any;

    const body = JSON.parse(res.body);
    const monthly = body.data.plans.find((p: any) => p.period === 'monthly');
    const yearly = body.data.plans.find((p: any) => p.period === 'yearly');

    // INR amounts are in rupees directly
    expect(monthly.amount).toBe(99);
    expect(yearly.amount).toBe(999);
  });

  // ── 6. Returns savings info for yearly plans ───────────────────

  it('returns savings info for yearly plans', async () => {
    mockSSMPrices('usd');

    const res = await handler(makeEvent()) as any;

    const body = JSON.parse(res.body);
    const yearly = body.data.plans.find((p: any) => p.period === 'yearly');

    expect(yearly.savings).toBe('17%');
    expect(yearly.monthlyEquivalent).toBeDefined();
    expect(yearly.monthlyEquivalent).toBe(1.67); // $1.67 in dollars
  });

  it('returns savings info for yearly INR plans', async () => {
    mockSSMPrices('inr');

    const res = await handler(makeEvent({ currency: 'INR' })) as any;

    const body = JSON.parse(res.body);
    const yearly = body.data.plans.find((p: any) => p.period === 'yearly');

    expect(yearly.savings).toBe('17%');
    expect(yearly.monthlyEquivalent).toBe(83);
  });

  it('monthly plans do not have savings info', async () => {
    mockSSMPrices('usd');

    const res = await handler(makeEvent()) as any;

    const body = JSON.parse(res.body);
    const monthly = body.data.plans.find((p: any) => p.period === 'monthly');

    expect(monthly.savings).toBeUndefined();
  });

  // ── 7. Returns 500 when SSM throws unexpected error ────────────

  it('returns 500 when SSM throws unexpected error', async () => {
    ssmMock.on(GetParameterCommand).rejects(new Error('SSM service unavailable'));

    const res = await handler(makeEvent()) as any;

    expect(res.statusCode).toBe(500);
    const body = JSON.parse(res.body);
    expect(body.errorCode).toBe('INTERNAL_ERROR');
    expect(body.message).toContain('Failed to fetch subscription plans');
  });

  // ── Additional edge cases ──────────────────────────────────────

  it('handles lowercase currency query param', async () => {
    mockSSMPrices('inr');

    const res = await handler(makeEvent({ currency: 'inr' })) as any;

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.data.currency).toBe('INR');
    expect(body.data.plans).toHaveLength(2);
  });

  it('returns partial plans when only monthly SSM param exists', async () => {
    ssmMock
      .on(GetParameterCommand, { Name: '/tradequt/test/stripe/price/monthly_usd' })
      .resolves({ Parameter: { Value: 'price_test_monthly_usd' } });

    const paramNotFound = new Error('Parameter not found');
    (paramNotFound as any).name = 'ParameterNotFound';
    ssmMock
      .on(GetParameterCommand, { Name: '/tradequt/test/stripe/price/yearly_usd' })
      .rejects(paramNotFound);

    const res = await handler(makeEvent()) as any;

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.data.plans).toHaveLength(1);
    expect(body.data.plans[0].period).toBe('monthly');
  });

  it('returns plan metadata (name, description, interval)', async () => {
    mockSSMPrices('usd');

    const res = await handler(makeEvent()) as any;

    const body = JSON.parse(res.body);
    const monthly = body.data.plans.find((p: any) => p.period === 'monthly');

    expect(monthly.name).toBe('TradeQut Pro Monthly');
    expect(monthly.description).toBeDefined();
    expect(monthly.interval).toBe(1);
    expect(monthly.currency).toBe('USD');
  });
});
