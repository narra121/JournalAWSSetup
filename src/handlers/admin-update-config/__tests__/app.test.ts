import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { SSMClient, PutParameterCommand } from '@aws-sdk/client-ssm';
import type { APIGatewayProxyEventV2 } from 'aws-lambda';

const ssmMock = mockClient(SSMClient);

function makeEvent(body?: any): APIGatewayProxyEventV2 {
  return {
    version: '2.0',
    routeKey: 'PUT /v1/admin/config',
    rawPath: '/v1/admin/config',
    rawQueryString: '',
    headers: {},
    requestContext: {
      accountId: '123',
      apiId: 'api',
      domainName: 'api.example.com',
      domainPrefix: 'api',
      http: { method: 'PUT', path: '/v1/admin/config', protocol: 'HTTP/1.1', sourceIp: '127.0.0.1', userAgent: 'test' },
      requestId: 'req-1',
      routeKey: 'PUT /v1/admin/config',
      stage: '$default',
      time: '01/Jan/2024:00:00:00 +0000',
      timeEpoch: 0,
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
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

describe('admin-update-config handler', () => {
  it('updates a String parameter successfully', async () => {
    const handler = await freshHandler();
    ssmMock.on(PutParameterCommand).resolves({ Version: 2 });

    const res = await handler(makeEvent({
      name: '/tradequt/dev/adConfig',
      value: '{"enabled":false}',
      type: 'String',
    }), {} as any, () => {}) as any;

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(true);
    expect(body.message).toBe('Config updated');
    expect(body.data.name).toBe('/tradequt/dev/adConfig');
    expect(body.data.type).toBe('String');
    expect(body.data.value).toBe('{"enabled":false}');

    const calls = ssmMock.commandCalls(PutParameterCommand);
    expect(calls).toHaveLength(1);
    expect(calls[0].args[0].input).toEqual({
      Name: '/tradequt/dev/adConfig',
      Value: '{"enabled":false}',
      Type: 'String',
      Overwrite: true,
    });
  });

  it('updates a SecureString parameter and masks the value in response', async () => {
    const handler = await freshHandler();
    ssmMock.on(PutParameterCommand).resolves({ Version: 3 });

    const res = await handler(makeEvent({
      name: '/tradequt/prod/stripeSecretKey',
      value: 'sk_live_9876543210',
      type: 'SecureString',
    }), {} as any, () => {}) as any;

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.data.value).toBe('••••3210');
  });

  it('rejects names not starting with /tradequt/', async () => {
    const handler = await freshHandler();

    const res = await handler(makeEvent({
      name: '/other/param',
      value: 'test',
      type: 'String',
    }), {} as any, () => {}) as any;

    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(false);
    expect(body.errorCode).toBe('VALIDATION_ERROR');
    expect(body.message).toContain('/tradequt/');

    const calls = ssmMock.commandCalls(PutParameterCommand);
    expect(calls).toHaveLength(0);
  });

  it('rejects missing fields', async () => {
    const handler = await freshHandler();

    // Missing value
    let res = await handler(makeEvent({ name: '/tradequt/test', type: 'String' }), {} as any, () => {}) as any;
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).errorCode).toBe('VALIDATION_ERROR');

    // Missing name
    res = await handler(makeEvent({ value: 'test', type: 'String' }), {} as any, () => {}) as any;
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).errorCode).toBe('VALIDATION_ERROR');

    // Missing type
    res = await handler(makeEvent({ name: '/tradequt/test', value: 'test' }), {} as any, () => {}) as any;
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).errorCode).toBe('VALIDATION_ERROR');

    // Missing body entirely
    res = await handler(makeEvent(), {} as any, () => {}) as any;
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).errorCode).toBe('VALIDATION_ERROR');
  });

  it('rejects invalid type values', async () => {
    const handler = await freshHandler();

    const res = await handler(makeEvent({
      name: '/tradequt/test',
      value: 'test',
      type: 'StringList',
    }), {} as any, () => {}) as any;

    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.errorCode).toBe('VALIDATION_ERROR');
    expect(body.message).toContain('type');
  });

  it('returns 500 when SSM fails', async () => {
    const handler = await freshHandler();
    ssmMock.on(PutParameterCommand).rejects(new Error('SSM write failed'));

    const res = await handler(makeEvent({
      name: '/tradequt/test',
      value: 'val',
      type: 'String',
    }), {} as any, () => {}) as any;

    expect(res.statusCode).toBe(500);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(false);
    expect(body.errorCode).toBe('INTERNAL_ERROR');
  });
});
