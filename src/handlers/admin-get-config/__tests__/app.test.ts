import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { SSMClient, GetParametersByPathCommand } from '@aws-sdk/client-ssm';
import type { APIGatewayProxyEventV2 } from 'aws-lambda';

const ssmMock = mockClient(SSMClient);

function makeEvent(): APIGatewayProxyEventV2 {
  return {
    version: '2.0',
    routeKey: 'GET /v1/admin/config',
    rawPath: '/v1/admin/config',
    rawQueryString: '',
    headers: {},
    requestContext: {
      accountId: '123',
      apiId: 'api',
      domainName: 'api.example.com',
      domainPrefix: 'api',
      http: { method: 'GET', path: '/v1/admin/config', protocol: 'HTTP/1.1', sourceIp: '127.0.0.1', userAgent: 'test' },
      requestId: 'req-1',
      routeKey: 'GET /v1/admin/config',
      stage: '$default',
      time: '01/Jan/2024:00:00:00 +0000',
      timeEpoch: 0,
    },
    isBase64Encoded: false,
  } as unknown as APIGatewayProxyEventV2;
}

async function freshHandler() {
  vi.resetModules();
  const mod = await import('../app');
  return mod.handler;
}

beforeEach(() => {
  ssmMock.reset();
});

describe('admin-get-config handler', () => {
  it('returns parameters with SecureString masked and String unmasked', async () => {
    const handler = await freshHandler();
    ssmMock.on(GetParametersByPathCommand).resolves({
      Parameters: [
        {
          Name: '/tradequt/dev/stripeSecretKey',
          Type: 'SecureString',
          Value: 'sk_test_abc12345678',
          LastModifiedDate: new Date('2026-04-20T10:00:00Z'),
        },
        {
          Name: '/tradequt/dev/adConfig',
          Type: 'String',
          Value: '{"enabled":true}',
          LastModifiedDate: new Date('2026-04-19T08:00:00Z'),
        },
      ],
      NextToken: undefined,
    });

    const res = await handler(makeEvent(), {} as any, () => {}) as any;

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(true);
    expect(body.message).toBe('Config retrieved');
    expect(body.data.parameters).toHaveLength(2);

    // Sorted by name: adConfig comes before stripeSecretKey
    const [adConfig, stripe] = body.data.parameters;

    expect(adConfig.name).toBe('/tradequt/dev/adConfig');
    expect(adConfig.type).toBe('String');
    expect(adConfig.value).toBe('{"enabled":true}');
    expect(adConfig.lastModified).toBe('2026-04-19T08:00:00.000Z');

    expect(stripe.name).toBe('/tradequt/dev/stripeSecretKey');
    expect(stripe.type).toBe('SecureString');
    expect(stripe.value).toBe('••••5678');
    expect(stripe.lastModified).toBe('2026-04-20T10:00:00.000Z');
  });

  it('masks SecureString values with 4 or fewer characters as ••••', async () => {
    const handler = await freshHandler();
    ssmMock.on(GetParametersByPathCommand).resolves({
      Parameters: [
        {
          Name: '/tradequt/short',
          Type: 'SecureString',
          Value: 'ab',
          LastModifiedDate: new Date('2026-04-20T10:00:00Z'),
        },
      ],
      NextToken: undefined,
    });

    const res = await handler(makeEvent(), {} as any, () => {}) as any;

    const body = JSON.parse(res.body);
    expect(body.data.parameters[0].value).toBe('••••');
  });

  it('paginates through multiple SSM pages', async () => {
    const handler = await freshHandler();

    ssmMock.on(GetParametersByPathCommand)
      .resolvesOnce({
        Parameters: [
          { Name: '/tradequt/param1', Type: 'String', Value: 'val1', LastModifiedDate: new Date('2026-01-01') },
        ],
        NextToken: 'page2',
      })
      .resolvesOnce({
        Parameters: [
          { Name: '/tradequt/param2', Type: 'String', Value: 'val2', LastModifiedDate: new Date('2026-01-02') },
        ],
        NextToken: undefined,
      });

    const res = await handler(makeEvent(), {} as any, () => {}) as any;

    const body = JSON.parse(res.body);
    expect(body.data.parameters).toHaveLength(2);
    expect(body.data.parameters[0].name).toBe('/tradequt/param1');
    expect(body.data.parameters[1].name).toBe('/tradequt/param2');

    const calls = ssmMock.commandCalls(GetParametersByPathCommand);
    expect(calls).toHaveLength(2);
    expect(calls[1].args[0].input.NextToken).toBe('page2');
  });

  it('returns sorted parameters', async () => {
    const handler = await freshHandler();
    ssmMock.on(GetParametersByPathCommand).resolves({
      Parameters: [
        { Name: '/tradequt/z-param', Type: 'String', Value: 'z', LastModifiedDate: new Date() },
        { Name: '/tradequt/a-param', Type: 'String', Value: 'a', LastModifiedDate: new Date() },
        { Name: '/tradequt/m-param', Type: 'String', Value: 'm', LastModifiedDate: new Date() },
      ],
      NextToken: undefined,
    });

    const res = await handler(makeEvent(), {} as any, () => {}) as any;

    const body = JSON.parse(res.body);
    const names = body.data.parameters.map((p: any) => p.name);
    expect(names).toEqual(['/tradequt/a-param', '/tradequt/m-param', '/tradequt/z-param']);
  });

  it('returns 500 when SSM fails', async () => {
    const handler = await freshHandler();
    ssmMock.on(GetParametersByPathCommand).rejects(new Error('SSM unavailable'));

    const res = await handler(makeEvent(), {} as any, () => {}) as any;

    expect(res.statusCode).toBe(500);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(false);
    expect(body.errorCode).toBe('INTERNAL_ERROR');
  });
});
