import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { APIGatewayProxyEventV2 } from 'aws-lambda';

const purgeUser = vi.fn();
vi.mock('../../../shared/account-data', () => ({ purgeUser: (...a: any[]) => purgeUser(...a) }));

const { handler } = await import('../app');

const TEST_USER_ID = 'user-abc-123';

function makeEvent(pathUserId?: string, body?: any): APIGatewayProxyEventV2 {
  return {
    version: '2.0',
    routeKey: 'DELETE /v1/admin/users/{userId}',
    rawPath: `/v1/admin/users/${pathUserId || ''}`,
    rawQueryString: '',
    headers: {},
    pathParameters: pathUserId ? { userId: pathUserId } : undefined,
    body: body !== undefined ? (typeof body === 'string' ? body : JSON.stringify(body)) : undefined,
    requestContext: { requestId: 'req-1', http: { method: 'DELETE' } },
    isBase64Encoded: false,
  } as unknown as APIGatewayProxyEventV2;
}

const call = async (e: APIGatewayProxyEventV2) => (await handler(e, {} as any, () => {})) as any;

beforeEach(() => {
  purgeUser.mockReset().mockResolvedValue({
    deleted: { trades: 3, accounts: 1, goals: 2, rules: 4, stats: 5, aiData: 0, usage: 0 },
    images: 7,
    errorReports: 0,
    stripeSubscriptionCancelled: true,
  });
});

describe('admin-delete-user handler', () => {
  it('returns 400 if userId path parameter is missing', async () => {
    expect((await call(makeEvent(undefined, { confirmText: 'delete' }))).statusCode).toBe(400);
  });

  it('returns 400 if confirmText is missing or wrong', async () => {
    expect((await call(makeEvent(TEST_USER_ID, {}))).statusCode).toBe(400);
    expect((await call(makeEvent(TEST_USER_ID, { confirmText: 'nope' }))).statusCode).toBe(400);
    expect(purgeUser).not.toHaveBeenCalled();
  });

  it('returns 400 if body is invalid JSON', async () => {
    expect((await call(makeEvent(TEST_USER_ID, '{not json'))).statusCode).toBe(400);
  });

  it('runs the shared purge and reports the counts, including screenshots and the Stripe cancellation', async () => {
    const res = await call(makeEvent(TEST_USER_ID, { confirmText: 'delete' }));
    expect(res.statusCode).toBe(200);
    expect(purgeUser).toHaveBeenCalledWith(TEST_USER_ID, expect.anything());
    expect(JSON.parse(res.body).data).toEqual({
      deletedTrades: 3,
      deletedAccounts: 1,
      deletedGoals: 2,
      deletedRules: 4,
      deletedStats: 5,
      deletedImages: 7,
      stripeSubscriptionCancelled: true,
    });
  });

  it('returns 500 when the purge fails', async () => {
    purgeUser.mockRejectedValue(new Error('Cognito down'));
    expect((await call(makeEvent(TEST_USER_ID, { confirmText: 'delete' }))).statusCode).toBe(500);
  });
});
