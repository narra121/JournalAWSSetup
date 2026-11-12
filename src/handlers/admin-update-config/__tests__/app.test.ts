import { PutParameterCommand, SSMClient } from '@aws-sdk/client-ssm';
import { mockClient } from 'aws-sdk-client-mock';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.stubEnv('AD_CONFIG_PARAM', '/tradequt/dev/adConfig');
const ssm = mockClient(SSMClient);
const { handler } = await import('../app');
const call = async (body?: any) =>
  (await handler({ requestContext: { requestId: 'r' }, body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body) } as any, {} as any, () => {})) as any;

beforeEach(() => {
  ssm.reset();
  ssm.on(PutParameterCommand).resolves({});
});

describe('admin-update-config', () => {
  it('writes the ad configuration as a plain String parameter', async () => {
    const res = await call({ name: '/tradequt/dev/adConfig', value: '{"a":1}', type: 'SecureString' });
    expect(res.statusCode).toBe(200);
    expect(ssm.commandCalls(PutParameterCommand)[0].args[0].input).toEqual({ Name: '/tradequt/dev/adConfig', Value: '{"a":1}', Type: 'String', Overwrite: true });
  });

  it.each([
    ['the Stripe secret', '/tradequt/dev/stripeSecretKey'],
    ['the admin JWT secret', '/tradequt/adminJwtSecret'],
    ['another stage\'s ad config', '/tradequt/prod/adConfig'],
  ])('refuses to overwrite %s', async (_n, name) => {
    const res = await call({ name, value: 'x' });
    expect(res.statusCode).toBe(400);
    expect(ssm.commandCalls(PutParameterCommand)).toHaveLength(0);
  });

  it('400 for missing body, invalid JSON and missing fields', async () => {
    expect((await call()).statusCode).toBe(400);
    expect((await call('{oops')).statusCode).toBe(400);
    expect((await call({ name: '/tradequt/dev/adConfig' })).statusCode).toBe(400);
  });
});
