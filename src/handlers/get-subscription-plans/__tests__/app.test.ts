import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';
import type { APIGatewayProxyEvent } from 'aws-lambda';

// Mock environment variables before importing handler
vi.stubEnv('STAGE_NAME', 'test');

const ssmMock = mockClient(SSMClient);

const { handler } = await import('../app.ts');

// ─── Helpers ────────────────────────────────────────────────────

function makeEvent(overrides: Partial<APIGatewayProxyEvent> = {}): APIGatewayProxyEvent {
  return {
    httpMethod: 'GET',
    path: '/subscription-plans',
    headers: {},
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
      httpMethod: 'GET',
      identity: {
        accessKey: null, accountId: null, apiKey: null, apiKeyId: null, caller: null,
        clientCert: null, cognitoAuthenticationProvider: null, cognitoAuthenticationType: null,
        cognitoIdentityId: null, cognitoIdentityPoolId: null, principalOrgId: null,
        sourceIp: '127.0.0.1', user: null, userAgent: 'test', userArn: null,
      },
      path: '/subscription-plans',
      stage: '$default',
      requestId: 'req-1',
      requestTimeEpoch: 0,
      resourceId: '',
      resourcePath: '/subscription-plans',
    },
    resource: '/subscription-plans',
    body: null,
    isBase64Encoded: false,
    ...overrides,
  } as APIGatewayProxyEvent;
}

// ─── Tests ──────────────────────────────────────────────────────

beforeEach(() => {
  ssmMock.reset();
});

describe('get-subscription-plans handler', () => {
  // ── Success ─────────────────────────────────────────────────

  it('returns 200 with all 4 plans when all SSM parameters exist', async () => {
    ssmMock.on(GetParameterCommand, { Name: '/tradequt/test/razorpay/plan/basic_monthly' })
      .resolves({ Parameter: { Value: 'plan_basic_monthly_id' } });
    ssmMock.on(GetParameterCommand, { Name: '/tradequt/test/razorpay/plan/basic_yearly' })
      .resolves({ Parameter: { Value: 'plan_basic_yearly_id' } });
    ssmMock.on(GetParameterCommand, { Name: '/tradequt/test/razorpay/plan/pro_monthly' })
      .resolves({ Parameter: { Value: 'plan_pro_monthly_id' } });
    ssmMock.on(GetParameterCommand, { Name: '/tradequt/test/razorpay/plan/pro_yearly' })
      .resolves({ Parameter: { Value: 'plan_pro_yearly_id' } });

    const res = await handler(makeEvent()) as any;

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(true);
    expect(body.data.plans).toHaveLength(4);
  });

  it('returns plans with correct tier, period, and amount details', async () => {
    ssmMock.on(GetParameterCommand, { Name: '/tradequt/test/razorpay/plan/basic_monthly' })
      .resolves({ Parameter: { Value: 'plan_bm' } });
    ssmMock.on(GetParameterCommand, { Name: '/tradequt/test/razorpay/plan/basic_yearly' })
      .resolves({ Parameter: { Value: 'plan_by' } });
    ssmMock.on(GetParameterCommand, { Name: '/tradequt/test/razorpay/plan/pro_monthly' })
      .resolves({ Parameter: { Value: 'plan_pm' } });
    ssmMock.on(GetParameterCommand, { Name: '/tradequt/test/razorpay/plan/pro_yearly' })
      .resolves({ Parameter: { Value: 'plan_py' } });

    const res = await handler(makeEvent()) as any;
    const body = JSON.parse(res.body);
    const plans = body.data.plans;

    // Basic monthly
    const basicMonthly = plans.find((p: any) => p.tier === 'basic' && p.period === 'monthly');
    expect(basicMonthly).toBeDefined();
    expect(basicMonthly.amount).toBe(99);
    expect(basicMonthly.name).toBe('TradeQut Basic Monthly');
    expect(basicMonthly.planId).toBe('plan_bm');

    // Basic yearly
    const basicYearly = plans.find((p: any) => p.tier === 'basic' && p.period === 'yearly');
    expect(basicYearly).toBeDefined();
    expect(basicYearly.amount).toBe(999);
    expect(basicYearly.name).toBe('TradeQut Basic Yearly');
    expect(basicYearly.savings).toBe('17%');

    // Pro monthly
    const proMonthly = plans.find((p: any) => p.tier === 'pro' && p.period === 'monthly');
    expect(proMonthly).toBeDefined();
    expect(proMonthly.amount).toBe(299);
    expect(proMonthly.name).toBe('TradeQut Pro Monthly');

    // Pro yearly
    const proYearly = plans.find((p: any) => p.tier === 'pro' && p.period === 'yearly');
    expect(proYearly).toBeDefined();
    expect(proYearly.amount).toBe(2999);
    expect(proYearly.name).toBe('TradeQut Pro Yearly');
    expect(proYearly.savings).toBe('17%');
  });

  // ── ParameterNotFound ───────────────────────────────────────

  it('filters out null plans when ParameterNotFound', async () => {
    ssmMock.on(GetParameterCommand, { Name: '/tradequt/test/razorpay/plan/basic_monthly' })
      .resolves({ Parameter: { Value: 'plan_bm' } });

    const notFoundError = new Error('Parameter not found');
    (notFoundError as any).name = 'ParameterNotFound';

    ssmMock.on(GetParameterCommand, { Name: '/tradequt/test/razorpay/plan/basic_yearly' })
      .rejects(notFoundError);
    ssmMock.on(GetParameterCommand, { Name: '/tradequt/test/razorpay/plan/pro_monthly' })
      .rejects(notFoundError);
    ssmMock.on(GetParameterCommand, { Name: '/tradequt/test/razorpay/plan/pro_yearly' })
      .resolves({ Parameter: { Value: 'plan_py' } });

    const res = await handler(makeEvent()) as any;

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(true);
    // Only 2 plans should be returned (basic_monthly and pro_yearly)
    expect(body.data.plans).toHaveLength(2);
  });

  // ── SSM errors ──────────────────────────────────────────────

  it('returns 500 when SSM throws a non-ParameterNotFound error', async () => {
    const ssmError = new Error('SSM service unavailable');
    (ssmError as any).name = 'InternalServerError';

    ssmMock.on(GetParameterCommand).rejects(ssmError);

    const res = await handler(makeEvent()) as any;

    expect(res.statusCode).toBe(500);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(false);
    expect(body.errorCode).toBe('INTERNAL_ERROR');
  });

  // ── No plans available ─────────────────────────────────────

  it('returns empty plans array when all SSM parameters are not found', async () => {
    const notFoundError = new Error('Parameter not found');
    (notFoundError as any).name = 'ParameterNotFound';

    ssmMock.on(GetParameterCommand).rejects(notFoundError);

    const res = await handler(makeEvent()) as any;

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(true);
    expect(body.data.plans).toEqual([]);
  });

  it('returns empty plans array when SSM parameters have null values', async () => {
    ssmMock.on(GetParameterCommand).resolves({ Parameter: { Value: undefined } });

    const res = await handler(makeEvent()) as any;

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(true);
    expect(body.data.plans).toEqual([]);
  });

  // ── Plan data validation ───────────────────────────────────

  it('all plans have INR currency', async () => {
    ssmMock.on(GetParameterCommand, { Name: '/tradequt/test/razorpay/plan/basic_monthly' })
      .resolves({ Parameter: { Value: 'plan_bm' } });
    ssmMock.on(GetParameterCommand, { Name: '/tradequt/test/razorpay/plan/basic_yearly' })
      .resolves({ Parameter: { Value: 'plan_by' } });
    ssmMock.on(GetParameterCommand, { Name: '/tradequt/test/razorpay/plan/pro_monthly' })
      .resolves({ Parameter: { Value: 'plan_pm' } });
    ssmMock.on(GetParameterCommand, { Name: '/tradequt/test/razorpay/plan/pro_yearly' })
      .resolves({ Parameter: { Value: 'plan_py' } });

    const res = await handler(makeEvent()) as any;
    const body = JSON.parse(res.body);

    for (const plan of body.data.plans) {
      expect(plan.currency).toBe('INR');
    }
  });

  it('all plans have interval set to 1', async () => {
    ssmMock.on(GetParameterCommand, { Name: '/tradequt/test/razorpay/plan/basic_monthly' })
      .resolves({ Parameter: { Value: 'plan_bm' } });
    ssmMock.on(GetParameterCommand, { Name: '/tradequt/test/razorpay/plan/basic_yearly' })
      .resolves({ Parameter: { Value: 'plan_by' } });
    ssmMock.on(GetParameterCommand, { Name: '/tradequt/test/razorpay/plan/pro_monthly' })
      .resolves({ Parameter: { Value: 'plan_pm' } });
    ssmMock.on(GetParameterCommand, { Name: '/tradequt/test/razorpay/plan/pro_yearly' })
      .resolves({ Parameter: { Value: 'plan_py' } });

    const res = await handler(makeEvent()) as any;
    const body = JSON.parse(res.body);

    for (const plan of body.data.plans) {
      expect(plan.interval).toBe(1);
    }
  });

  it('yearly plans include savings and monthlyEquivalent fields', async () => {
    ssmMock.on(GetParameterCommand, { Name: '/tradequt/test/razorpay/plan/basic_monthly' })
      .resolves({ Parameter: { Value: 'plan_bm' } });
    ssmMock.on(GetParameterCommand, { Name: '/tradequt/test/razorpay/plan/basic_yearly' })
      .resolves({ Parameter: { Value: 'plan_by' } });
    ssmMock.on(GetParameterCommand, { Name: '/tradequt/test/razorpay/plan/pro_monthly' })
      .resolves({ Parameter: { Value: 'plan_pm' } });
    ssmMock.on(GetParameterCommand, { Name: '/tradequt/test/razorpay/plan/pro_yearly' })
      .resolves({ Parameter: { Value: 'plan_py' } });

    const res = await handler(makeEvent()) as any;
    const body = JSON.parse(res.body);
    const plans = body.data.plans;

    const basicYearly = plans.find((p: any) => p.tier === 'basic' && p.period === 'yearly');
    expect(basicYearly.savings).toBe('17%');
    expect(basicYearly.monthlyEquivalent).toBe(99);

    const proYearly = plans.find((p: any) => p.tier === 'pro' && p.period === 'yearly');
    expect(proYearly.savings).toBe('17%');
    expect(proYearly.monthlyEquivalent).toBe(299);
  });

  it('monthly plans do not include savings field', async () => {
    ssmMock.on(GetParameterCommand, { Name: '/tradequt/test/razorpay/plan/basic_monthly' })
      .resolves({ Parameter: { Value: 'plan_bm' } });
    ssmMock.on(GetParameterCommand, { Name: '/tradequt/test/razorpay/plan/basic_yearly' })
      .resolves({ Parameter: { Value: 'plan_by' } });
    ssmMock.on(GetParameterCommand, { Name: '/tradequt/test/razorpay/plan/pro_monthly' })
      .resolves({ Parameter: { Value: 'plan_pm' } });
    ssmMock.on(GetParameterCommand, { Name: '/tradequt/test/razorpay/plan/pro_yearly' })
      .resolves({ Parameter: { Value: 'plan_py' } });

    const res = await handler(makeEvent()) as any;
    const body = JSON.parse(res.body);
    const plans = body.data.plans;

    const basicMonthly = plans.find((p: any) => p.tier === 'basic' && p.period === 'monthly');
    expect(basicMonthly.savings).toBeUndefined();
    expect(basicMonthly.monthlyEquivalent).toBeUndefined();

    const proMonthly = plans.find((p: any) => p.tier === 'pro' && p.period === 'monthly');
    expect(proMonthly.savings).toBeUndefined();
    expect(proMonthly.monthlyEquivalent).toBeUndefined();
  });

  // ── Response shape ─────────────────────────────────────────

  it('response message is "Subscription plans retrieved" on success', async () => {
    ssmMock.on(GetParameterCommand, { Name: '/tradequt/test/razorpay/plan/basic_monthly' })
      .resolves({ Parameter: { Value: 'plan_bm' } });
    const notFoundError = new Error('Parameter not found');
    (notFoundError as any).name = 'ParameterNotFound';
    ssmMock.on(GetParameterCommand, { Name: '/tradequt/test/razorpay/plan/basic_yearly' })
      .rejects(notFoundError);
    ssmMock.on(GetParameterCommand, { Name: '/tradequt/test/razorpay/plan/pro_monthly' })
      .rejects(notFoundError);
    ssmMock.on(GetParameterCommand, { Name: '/tradequt/test/razorpay/plan/pro_yearly' })
      .rejects(notFoundError);

    const res = await handler(makeEvent()) as any;
    const body = JSON.parse(res.body);
    expect(body.message).toBe('Subscription plans retrieved');
  });

  it('returns 500 with error message when SSM throws AccessDeniedException', async () => {
    const accessError = new Error('Access denied');
    (accessError as any).name = 'AccessDeniedException';

    ssmMock.on(GetParameterCommand).rejects(accessError);

    const res = await handler(makeEvent()) as any;

    expect(res.statusCode).toBe(500);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(false);
    expect(body.errorCode).toBe('INTERNAL_ERROR');
    expect(body.message).toBe('Failed to fetch subscription plans');
  });

  // ── Partial plan availability ──────────────────────────────

  it('returns only basic plans when pro plans are not found', async () => {
    ssmMock.on(GetParameterCommand, { Name: '/tradequt/test/razorpay/plan/basic_monthly' })
      .resolves({ Parameter: { Value: 'plan_bm' } });
    ssmMock.on(GetParameterCommand, { Name: '/tradequt/test/razorpay/plan/basic_yearly' })
      .resolves({ Parameter: { Value: 'plan_by' } });

    const notFoundError = new Error('Parameter not found');
    (notFoundError as any).name = 'ParameterNotFound';
    ssmMock.on(GetParameterCommand, { Name: '/tradequt/test/razorpay/plan/pro_monthly' })
      .rejects(notFoundError);
    ssmMock.on(GetParameterCommand, { Name: '/tradequt/test/razorpay/plan/pro_yearly' })
      .rejects(notFoundError);

    const res = await handler(makeEvent()) as any;

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.data.plans).toHaveLength(2);
    expect(body.data.plans.every((p: any) => p.tier === 'basic')).toBe(true);
  });
});
