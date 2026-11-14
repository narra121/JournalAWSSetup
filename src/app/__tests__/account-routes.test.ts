import { AdminUserGlobalSignOutCommand, CognitoIdentityProviderClient, ListUsersCommand } from '@aws-sdk/client-cognito-identity-provider';
import { DynamoDBDocumentClient, GetCommand } from '@aws-sdk/lib-dynamodb';
import { mockClient } from 'aws-sdk-client-mock';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.stubEnv('USER_POOL_ID', 'us-east-1_t');
vi.stubEnv('USER_POOL_CLIENT_ID', 'c');
vi.stubEnv('ALLOWED_ORIGINS', 'https://dev.tradequt.com');

const exportUserData = vi.fn();
const purgeUser = vi.fn();
vi.mock('../../shared/account-data', () => ({
  exportUserData: (...a: any[]) => exportUserData(...a),
  purgeUser: (...a: any[]) => purgeUser(...a),
}));

const cognito = mockClient(CognitoIdentityProviderClient);
mockClient(DynamoDBDocumentClient).on(GetCommand).resolves({ Item: { userId: 'u1', status: 'active', plansVersion: 2 } });
const { createApp } = await import('../app');
const { setTokenVerifier } = await import('../auth/cognito');
const app = createApp();
const auth = { authorization: 'Bearer good' };

beforeEach(() => {
  cognito.reset();
  exportUserData.mockReset().mockResolvedValue({ exportVersion: 1, exportedAt: '2026-11-11T10:00:00.000Z', trades: [] });
  purgeUser.mockReset().mockResolvedValue({ deleted: { trades: 2 }, images: 1, errorReports: 0, stripeSubscriptionCancelled: false });
  cognito.on(ListUsersCommand).resolves({ Users: [{ Username: 'Google_111' }] });
  cognito.on(AdminUserGlobalSignOutCommand).resolves({});
  setTokenVerifier({
    verify: async (t) =>
      t === 'good'
        ? { sub: 'u1', email: 'u@x.y' }
        : t === 'local'
          ? { sub: 'u1', 'cognito:username': 'Google_222' }
          : Promise.reject(new Error('bad')),
  });
});

describe('account routes', () => {
  it('require authentication', async () => {
    for (const [method, path] of [['GET', '/v1/auth/export'], ['DELETE', '/v1/auth/account'], ['POST', '/v1/auth/logout-all']]) {
      expect((await app.request(path, { method })).status).toBe(401);
    }
    expect(purgeUser).not.toHaveBeenCalled();
  });

  it('GET /v1/auth/export returns the caller\'s data as a download', async () => {
    const res = await app.request('/v1/auth/export', { headers: auth });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-disposition')).toBe('attachment; filename="tradequt-export-2026-11-11.json"');
    expect((await res.json()).data.exportVersion).toBe(1);
    expect(exportUserData).toHaveBeenCalledWith('u1', 'u@x.y');
  });

  it('DELETE /v1/auth/account purges only the caller', async () => {
    const res = await app.request('/v1/auth/account', { method: 'DELETE', headers: auth });
    expect(res.status).toBe(200);
    expect(purgeUser).toHaveBeenCalledWith('u1', expect.anything(), expect.objectContaining({ sub: 'u1' }));
    expect((await res.json()).data.deleted.trades).toBe(2);
  });

  it('POST /v1/auth/logout-all signs the caller out with the pool username found by sub, not the sub itself (BE-003)', async () => {
    const res = await app.request('/v1/auth/logout-all', { method: 'POST', headers: auth });
    expect(res.status).toBe(200);
    expect((await res.json()).message).toContain('within an hour');
    expect(cognito.commandCalls(ListUsersCommand)[0].args[0].input).toMatchObject({ UserPoolId: 'us-east-1_t', Filter: 'sub = "u1"' });
    expect(cognito.commandCalls(AdminUserGlobalSignOutCommand)[0].args[0].input).toEqual({ UserPoolId: 'us-east-1_t', Username: 'Google_111' });
  });

  it('POST /v1/auth/logout-all uses the cognito:username claim when the token has it, with no lookup', async () => {
    const res = await app.request('/v1/auth/logout-all', { method: 'POST', headers: { authorization: 'Bearer local' } });
    expect(res.status).toBe(200);
    expect(cognito.commandCalls(ListUsersCommand)).toHaveLength(0);
    expect(cognito.commandCalls(AdminUserGlobalSignOutCommand)[0].args[0].input).toEqual({ UserPoolId: 'us-east-1_t', Username: 'Google_222' });
  });
});
