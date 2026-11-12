import { GetParameterCommand, SSMClient } from '@aws-sdk/client-ssm';
import { mockClient } from 'aws-sdk-client-mock';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.stubEnv('AD_CONFIG_PARAM', '/tradequt/dev/adConfig');
const ssm = mockClient(SSMClient);
const { handler } = await import('../app');
const call = async () => (await handler({ requestContext: { requestId: 'r' } } as any, {} as any, () => {})) as any;

beforeEach(() => {
  ssm.reset();
});

describe('admin-get-config', () => {
  it('returns only the ad configuration parameter, unmasked, and reads nothing else', async () => {
    ssm.on(GetParameterCommand).resolves({ Parameter: { Name: '/tradequt/dev/adConfig', Type: 'String', Value: '{"slots":[]}', LastModifiedDate: new Date('2026-11-01T00:00:00Z') } });
    const res = await call();
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).data.parameters).toEqual([{ name: '/tradequt/dev/adConfig', type: 'String', value: '{"slots":[]}', lastModified: '2026-11-01T00:00:00.000Z' }]);
    expect(ssm.commandCalls(GetParameterCommand).map((c) => c.args[0].input.Name)).toEqual(['/tradequt/dev/adConfig']);
  });

  it('returns an empty list when the parameter does not exist yet', async () => {
    ssm.on(GetParameterCommand).rejects(Object.assign(new Error('nf'), { name: 'ParameterNotFound' }));
    expect(JSON.parse((await call()).body).data.parameters).toEqual([]);
  });

  it('500 on other SSM errors', async () => {
    ssm.on(GetParameterCommand).rejects(new Error('denied'));
    expect((await call()).statusCode).toBe(500);
  });
});
