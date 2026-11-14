import { AdminDeleteUserCommand, CognitoIdentityProviderClient, ListUsersCommand } from '@aws-sdk/client-cognito-identity-provider';
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
const customersDel = vi.fn();
vi.mock('../stripe-config', () => ({ getStripe: async () => ({ subscriptions: { cancel: subscriptionsCancel }, customers: { del: customersDel } }) }));
vi.mock('../batchWrite', () => ({
  batchWriteDeleteAll: vi.fn(async ({ tableName, keys }: any) => {
    order.push(`ddb:${tableName}:${keys.length}`);
  }),
}));

const ddb = mockClient(DynamoDBDocumentClient);
const s3 = mockClient(S3Client);
const cognito = mockClient(CognitoIdentityProviderClient);
const { exportUserData, purgeUser } = await import('../account-data');

const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);

beforeEach(() => {
  order.length = 0;
  ddb.reset();
  s3.reset();
  cognito.reset();
  subscriptionsCancel.mockReset().mockResolvedValue({});
  customersDel.mockReset().mockResolvedValue({ deleted: true });
  ddb.on(GetCommand).resolves({ Item: { userId: 'u1', stripeSubscriptionId: 'sub_1', stripeCustomerId: 'cus_1', status: 'active' } });
  ddb.on(QueryCommand).callsFake((input) => ({ Items: [{ userId: 'u1', k: input.TableName }] }));
  ddb.on(DeleteCommand).callsFake((input) => {
    order.push(`del:${input.TableName}`);
    return {};
  });
  s3.on(ListObjectsV2Command).callsFake((input) => {
    if (input.Bucket === 'images-bucket' && input.Prefix === 'images/u1/') return { Contents: [{ Key: 'images/u1/t1/a.png' }] };
    if (input.Bucket === 'images-bucket' && input.Prefix === 'images/upload/u1/') return { Contents: [{ Key: 'images/upload/u1/pending.png' }] };
    if (input.Prefix === 'errors/u1/') return { Contents: [{ Key: 'errors/u1/2026-11-01/x.json' }] };
    if (input.Prefix === `errors/${daysAgo(3)}/u1/`) return { Contents: [{ Key: `errors/${daysAgo(3)}/u1/old.json` }] };
    return {};
  });
  s3.on(DeleteObjectsCommand).callsFake((input) => {
    order.push(`s3:${input.Bucket}:${input.Delete.Objects.map((o: any) => o.Key).join(',')}`);
    return {};
  });
  cognito.on(ListUsersCommand).resolves({ Users: [{ Username: 'Google_111' }] });
  cognito.on(AdminDeleteUserCommand).callsFake((input) => {
    order.push(`cognito:${input.Username}`);
    return {};
  });
});

describe('purgeUser', () => {
  it('cancels Stripe, deletes every table, the user\'s screenshots and error reports, and Cognito LAST', async () => {
    const result = await purgeUser('u1');
    expect(subscriptionsCancel).toHaveBeenCalledWith('sub_1');
    expect(customersDel).toHaveBeenCalledWith('cus_1');
    expect(order.filter((o) => o.startsWith('ddb:')).map((o) => o.split(':')[1])).toEqual(['accounts', 'trades', 'goals', 'rules', 'stats', 'ai', 'usage']);
    expect(order.filter((o) => o.startsWith('del:')).map((o) => o.split(':')[1])).toEqual(['stats', 'subs', 'prefs', 'opts']);
    expect(order).toContain('s3:images-bucket:images/u1/t1/a.png,images/upload/u1/pending.png');
    expect(order.some((o) => o.startsWith('s3:errors-bucket:') && o.includes('errors/u1/2026-11-01/x.json'))).toBe(true);
    expect(order.some((o) => o.startsWith('s3:errors-bucket:') && o.includes(`errors/${daysAgo(3)}/u1/old.json`))).toBe(true);
    expect(order[order.length - 1]).toBe('cognito:Google_111');
    expect(result).toMatchObject({ images: 2, errorReports: 2, stripeSubscriptionCancelled: true });
    expect(result.deleted.trades).toBe(1);
  });

  it('purges the accounts before the trades, so the trade REMOVE records of the purge find no account (M6)', async () => {
    await purgeUser('u1');
    const tables = order.filter((o) => o.startsWith('ddb:')).map((o) => o.split(':')[1]);
    expect(tables.indexOf('accounts')).toBeLessThan(tables.indexOf('trades'));
  });

  it('deletes the #dirty flag that update-stats set for the user, after the day records of the user (M6)', async () => {
    const dirty: any[] = [];
    ddb.on(DeleteCommand).callsFake((input) => {
      order.push(`del:${input.TableName}`);
      dirty.push(input);
      return {};
    });
    await purgeUser('u1');
    expect(dirty[0]).toEqual({ TableName: 'stats', Key: { userId: '#dirty', sk: 'u1' } });
    expect(order.indexOf('ddb:stats:1')).toBeLessThan(order.indexOf('del:stats'));
  });

  it('removes the per-user request counter, which the delete request itself has just written', async () => {
    vi.stubEnv('RATE_LIMIT_TABLE', 'ratelimit');
    const deletes: any[] = [];
    ddb.on(DeleteCommand).callsFake((input) => {
      deletes.push(input);
      return {};
    });
    try {
      await purgeUser('U1-Sub');
    } finally {
      vi.stubEnv('RATE_LIMIT_TABLE', '');
    }
    expect(deletes).toContainEqual({ TableName: 'ratelimit', Key: { key: 'user:u1-sub' } });
  });

  it('also removes uploads that were never attached to a trade (H10)', async () => {
    const result = await purgeUser('u1');
    const prefixes = s3.commandCalls(ListObjectsV2Command).filter((c) => c.args[0].input.Bucket === 'images-bucket').map((c) => c.args[0].input.Prefix);
    expect(prefixes).toEqual(['images/u1/', 'images/upload/u1/']);
    expect(order.some((o) => o.startsWith('s3:images-bucket:') && o.includes('images/upload/u1/pending.png'))).toBe(true);
    expect(result.images).toBe(2);
  });

  it('lists error reports by the user prefix instead of scanning every report (BE-073)', async () => {
    await purgeUser('u1');
    const prefixes = s3.commandCalls(ListObjectsV2Command).filter((c) => c.args[0].input.Bucket === 'errors-bucket').map((c) => c.args[0].input.Prefix);
    expect(prefixes).toContain('errors/u1/');
    expect(prefixes).not.toContain('errors/');
    expect(prefixes.every((p) => p === 'errors/u1/' || /^errors\/\d{4}-\d{2}-\d{2}\/u1\/$/.test(p!))).toBe(true);
  });

  it('deletes the Stripe customer so no email or card stays at Stripe (BE-024)', async () => {
    const result = await purgeUser('u1');
    expect(customersDel).toHaveBeenCalledTimes(1);
    expect(subscriptionsCancel.mock.invocationCallOrder[0]).toBeLessThan(customersDel.mock.invocationCallOrder[0]);
    expect(result.stripeSubscriptionCancelled).toBe(true);
  });

  it('treats an already-deleted Stripe customer as done', async () => {
    customersDel.mockRejectedValue(Object.assign(new Error('No such customer: cus_1'), { code: 'resource_missing' }));
    await purgeUser('u1');
    expect(order[order.length - 1]).toBe('cognito:Google_111');
  });

  it('does not touch data when the Stripe customer deletion fails', async () => {
    customersDel.mockRejectedValue(Object.assign(new Error('network'), { code: 'api_connection_error' }));
    await expect(purgeUser('u1')).rejects.toThrow('network');
    expect(order).toEqual([]);
  });

  describe('Cognito username (BE-003)', () => {
    it('deletes the user by the pool username found with a sub filter, not by the sub', async () => {
      await purgeUser('u1');
      expect(cognito.commandCalls(ListUsersCommand)[0].args[0].input).toMatchObject({ UserPoolId: 'pool', Filter: 'sub = "u1"' });
      expect(cognito.commandCalls(AdminDeleteUserCommand)[0].args[0].input).toEqual({ UserPoolId: 'pool', Username: 'Google_111' });
    });

    it('uses the signed-in token claim and skips the lookup', async () => {
      await purgeUser('u1', undefined, { sub: 'u1', 'cognito:username': 'Google_222' });
      expect(cognito.commandCalls(ListUsersCommand)).toHaveLength(0);
      expect(cognito.commandCalls(AdminDeleteUserCommand)[0].args[0].input.Username).toBe('Google_222');
    });

    it('ignores claims that belong to another user (an admin purging someone else)', async () => {
      await purgeUser('u1', undefined, { sub: 'admin', 'cognito:username': 'Google_ADMIN' });
      expect(cognito.commandCalls(AdminDeleteUserCommand)[0].args[0].input.Username).toBe('Google_111');
    });

    it('still purges the data of a user that is already gone from the pool, without a Cognito delete', async () => {
      cognito.on(ListUsersCommand).resolves({ Users: [] });
      const result = await purgeUser('u1');
      expect(result.deleted.trades).toBe(1);
      expect(cognito.commandCalls(AdminDeleteUserCommand)).toHaveLength(0);
    });

    it('stops before any data is removed when the lookup itself fails', async () => {
      cognito.on(ListUsersCommand).rejects(new Error('throttled'));
      await expect(purgeUser('u1')).rejects.toThrow('throttled');
      expect(order).toEqual([]);
    });
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
    expect(order[order.length - 1]).toBe('cognito:Google_111');
  });

  it('skips Stripe when the user never subscribed', async () => {
    ddb.on(GetCommand).resolves({ Item: { userId: 'u1', status: 'trial' } });
    await purgeUser('u1');
    expect(subscriptionsCancel).not.toHaveBeenCalled();
    expect(customersDel).not.toHaveBeenCalled();
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
