import { AdminDeleteUserCommand, CognitoIdentityProviderClient } from '@aws-sdk/client-cognito-identity-provider';
import { DeleteObjectsCommand, ListObjectsV2Command, S3Client } from '@aws-sdk/client-s3';
import { DeleteCommand, DynamoDBDocumentClient, GetCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { mockClient } from 'aws-sdk-client-mock';
import { beforeEach, describe, expect, it, vi } from 'vitest';

for (const [k, v] of Object.entries({
  USER_POOL_ID: 'pool',
  TRADES_TABLE: 'trades',
  ACCOUNTS_TABLE: 'accounts',
  GOALS_TABLE: 'goals',
  RULES_TABLE: 'rules',
  DAILY_STATS_TABLE: 'stats',
  AI_DATA_TABLE: 'ai',
  USAGE_TABLE: 'usage',
  SUBSCRIPTIONS_TABLE: 'subs',
  USER_PREFERENCES_TABLE: 'prefs',
  SAVED_OPTIONS_TABLE: 'opts',
  IMAGES_BUCKET: 'images-bucket',
  ERROR_REPORTS_BUCKET: 'errors-bucket',
})) vi.stubEnv(k, v);

const order: string[] = [];
const subscriptionsCancel = vi.fn();
vi.mock('../stripe-config', () => ({ getStripe: async () => ({ subscriptions: { cancel: subscriptionsCancel } }) }));
vi.mock('../batchWrite', () => ({
  batchWriteDeleteAll: vi.fn(async ({ tableName, keys }: any) => {
    order.push(`ddb:${tableName}:${keys.length}`);
  }),
}));

const ddb = mockClient(DynamoDBDocumentClient);
const s3 = mockClient(S3Client);
const cognito = mockClient(CognitoIdentityProviderClient);
const { exportUserData, purgeUser } = await import('../account-data');

beforeEach(() => {
  order.length = 0;
  ddb.reset();
  s3.reset();
  cognito.reset();
  subscriptionsCancel.mockReset().mockResolvedValue({});
  ddb.on(GetCommand).resolves({ Item: { userId: 'u1', stripeSubscriptionId: 'sub_1', stripeCustomerId: 'cus_1', status: 'active' } });
  ddb.on(QueryCommand).callsFake((input) => ({ Items: [{ userId: 'u1', k: input.TableName }] }));
  ddb.on(DeleteCommand).callsFake((input) => {
    order.push(`del:${input.TableName}`);
    return {};
  });
  s3.on(ListObjectsV2Command).callsFake((input) =>
    input.Bucket === 'images-bucket'
      ? { Contents: [{ Key: 'images/u1/t1/a.png' }] }
      : { Contents: [{ Key: 'errors/2026-11-01/u1/x.json' }, { Key: 'errors/2026-11-01/other/y.json' }] },
  );
  s3.on(DeleteObjectsCommand).callsFake((input) => {
    order.push(`s3:${input.Bucket}:${input.Delete.Objects.map((o: any) => o.Key).join(',')}`);
    return {};
  });
  cognito.on(AdminDeleteUserCommand).callsFake(() => {
    order.push('cognito');
    return {};
  });
});

describe('purgeUser', () => {
  it('cancels Stripe, deletes every table, the user\'s screenshots and error reports, and Cognito LAST', async () => {
    const result = await purgeUser('u1');
    expect(subscriptionsCancel).toHaveBeenCalledWith('sub_1');
    expect(order.filter((o) => o.startsWith('ddb:')).map((o) => o.split(':')[1])).toEqual(['trades', 'accounts', 'goals', 'rules', 'stats', 'ai', 'usage']);
    expect(order.filter((o) => o.startsWith('del:')).map((o) => o.split(':')[1])).toEqual(['subs', 'prefs', 'opts']);
    expect(order).toContain('s3:images-bucket:images/u1/t1/a.png');
    expect(order).toContain('s3:errors-bucket:errors/2026-11-01/u1/x.json');
    expect(order.some((o) => o.includes('other/y.json'))).toBe(false);
    expect(order[order.length - 1]).toBe('cognito');
    expect(result).toMatchObject({ images: 1, errorReports: 1, stripeSubscriptionCancelled: true });
    expect(result.deleted.trades).toBe(1);
  });

  it('does not touch data or Cognito when the Stripe cancellation fails', async () => {
    subscriptionsCancel.mockRejectedValue(Object.assign(new Error('network'), { code: 'api_connection_error' }));
    await expect(purgeUser('u1')).rejects.toThrow('network');
    expect(order).toEqual([]);
  });

  it('treats an already-missing Stripe subscription as cancelled', async () => {
    subscriptionsCancel.mockRejectedValue(Object.assign(new Error('No such subscription: sub_1'), { code: 'resource_missing' }));
    const result = await purgeUser('u1');
    expect(result.stripeSubscriptionCancelled).toBe(false);
    expect(order[order.length - 1]).toBe('cognito');
  });

  it('skips Stripe when the user never subscribed', async () => {
    ddb.on(GetCommand).resolves({ Item: { userId: 'u1', status: 'trial' } });
    await purgeUser('u1');
    expect(subscriptionsCancel).not.toHaveBeenCalled();
  });
});

describe('exportUserData', () => {
  it('returns the user\'s data and only non-sensitive subscription fields', async () => {
    ddb.on(GetCommand).callsFake((input) =>
      input.TableName === 'subs'
        ? { Item: { userId: 'u1', status: 'active', planId: 'price_1', currentEnd: '2026-12-01', stripeCustomerId: 'cus_SECRET', stripeSubscriptionId: 'sub_SECRET' } }
        : {},
    );
    const data = await exportUserData('u1', 'a@b.c');
    expect(data).toMatchObject({ exportVersion: 1, profile: { userId: 'u1', email: 'a@b.c' } });
    expect(data.trades).toHaveLength(1);
    expect(Object.keys(data)).toEqual(expect.arrayContaining(['accounts', 'trades', 'goals', 'rules', 'preferences', 'savedOptions', 'subscription', 'aiData']));
    expect(data.subscription).toEqual({ status: 'active', planId: 'price_1', currentStart: undefined, currentEnd: '2026-12-01', trialEnd: undefined });
    expect(JSON.stringify(data)).not.toContain('SECRET');
  });
});
