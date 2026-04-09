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
    ssmMock.on(GetParameterCommand, { Name: '/tradeflow/test/razorpay/plan/basic_monthly' })
      .resolves({ Parameter: { Value: 'plan_basic_monthly_id' } });
    ssmMock.on(GetParameterCommand, { Name: '/tradeflow/test/razorpay/plan/basic_yearly' })
      .resolves({ Parameter: { Value: 'plan_basic_yearly_id' } });
    ssmMock.on(GetParameterCommand, { Name: '/tradeflow/test/razorpay/plan/pro_monthly' })
      .resolves({ Parameter: { Value: 'plan_pro_monthly_id' } });
    ssmMock.on(GetParameterCommand, { Name: '/tradeflow/test/razorpay/plan/pro_yearly' })
      .resolves({ Parameter: { Value: 'plan_pro_yearly_id' } });

    const res = await handler(makeEvent()) as any;

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(true);
    expect(body.data.plans).toHaveLength(4);
  });

  it('returns plans with correct tier, period, and amount details', async () => {
    ssmMock.on(GetParameterCommand, { Name: '/tradeflow/test/razorpay/plan/basic_monthly' })
      .resolves({ Parameter: { Value: 'plan_bm' } });
    ssmMock.on(GetParameterCommand, { Name: '/tradeflow/test/razorpay/plan/basic_yearly' })
      .resolves({ Parameter: { Value: 'plan_by' } });
    ssmMock.on(GetParameterCommand, { Name: '/tradeflow/test/razorpay/plan/pro_monthly' })
      .resolves({ Parameter: { Value: 'plan_pm' } });
    ssmMock.on(GetParameterCommand, { Name: '/tradeflow/test/razorpay/plan/pro_yearly' })
      .resolves({ Parameter: { Value: 'plan_py' } });

    const res = await handler(makeEvent()) as any;
    const body = JSON.parse(res.body);
    const plans = body.data.plans;

    // Basic monthly
    const basicMonthly = plans.find((p: any) => p.tier === 'basic' && p.period === 'monthly');
    expect(basicMonthly).toBeDefined();
    expect(basicMonthly.amount).toBe(99);
    expect(basicMonthly.name).toBe('TradeFlow Basic Monthly');
    expect(basicMonthly.planId).toBe('plan_bm');

    // Basic yearly
    const basicYearly = plans.find((p: any) => p.tier === 'basic' && p.period === 'yearly');
    expect(basicYearly).toBeDefined();
    expect(basicYearly.amount).toBe(999);
    expect(basicYearly.name).toBe('TradeFlow Basic Yearly');
    expect(basicYearly.savings).toBe('17%');

    // Pro monthly
    const proMonthly = plans.find((p: any) => p.tier === 'pro' && p.period === 'monthly');
    expect(proMonthly).toBeDefined();
    expect(proMonthly.amount).toBe(299);
    expect(proMonthly.name).toBe('TradeFlow Pro Monthly');

    // Pro yearly
    const proYearly = plans.find((p: any) => p.tier === 'pro' && p.period === 'yearly');
    expect(proYearly).toBeDefined();
    expect(proYearly.amount).toBe(2999);
    expect(proYearly.name).toBe('TradeFlow Pro Yearly');
    expect(proYearly.savings).toBe('17%');
  });

  // ── ParameterNotFound ───────────────────────────────────────

  it('filters out null plans when ParameterNotFound', async () => {
    ssmMock.on(GetParameterCommand, { Name: '/tradeflow/test/razorpay/plan/basic_monthly' })
      .resolves({ Parameter: { Value: 'plan_bm' } });

    const notFoundError = new Error('Parameter not found');
    (notFoundError as any).name = 'ParameterNotFound';

    ssmMock.on(GetParameterCommand, { Name: '/tradeflow/test/razorpay/plan/basic_yearly' })
      .rejects(notFoundError);
    ssmMock.on(GetParameterCommand, { Name: '/tradeflow/test/razorpay/plan/pro_monthly' })
      .rejects(notFoundError);
    ssmMock.on(GetParameterCommand, { Name: '/tradeflow/test/razorpay/plan/pro_yearly' })
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
});
