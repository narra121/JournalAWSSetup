import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { mockClient } from 'aws-sdk-client-mock';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.stubEnv('SUBSCRIPTIONS_TABLE', 'subs');
vi.stubEnv('USAGE_TABLE', 'usage');
vi.stubEnv('PROD_USER_POOL_ID', 'us-east-1_PROD');

const extract = vi.fn();
vi.mock('../../handlers/extract-trades/app', () => ({ handler: (...a: any[]) => extract(...a) }));

const ddb = mockClient(DynamoDBDocumentClient);
const { legacyExtract, setLegacyVerifier } = await import('../legacy-extract');

const event = (token?: string) => ({ headers: token ? { authorization: `Bearer ${token}` } : {}, requestContext: {}, body: '{}' });

beforeEach(() => {
  ddb.reset();
  extract.mockReset();
  setLegacyVerifier({
    verify: async (t) =>
      t === 'dev-token'
        ? { sub: 'sub-dev-token', iss: 'https://cognito-idp.us-east-1.amazonaws.com/us-east-1_DEV' }
        : t === 'prod-token'
          ? { sub: 'sub-prod-token', iss: 'https://cognito-idp.us-east-1.amazonaws.com/us-east-1_PROD' }
          : Promise.reject(new Error('bad')),
  });
});

describe('legacyExtract (dev Function URL kept for the stale prod frontend)', () => {
  it('forged or missing tokens → 401 and the model is never called', async () => {
    expect((await legacyExtract(event('forged'))).statusCode).toBe(401);
    expect((await legacyExtract(event())).statusCode).toBe(401);
    expect(extract).not.toHaveBeenCalled();
  });

  it('a verified token runs the extract handler with the verified claims', async () => {
    ddb.on(GetCommand).resolves({});
    ddb.on(UpdateCommand).resolves({ Attributes: { count: 1 } });
    extract.mockResolvedValue({ statusCode: 200, body: '{"success":true}' });
    const res = await legacyExtract(event('prod-token'));
    expect(res.statusCode).toBe(200);
    expect(extract.mock.calls[0][0].requestContext.authorizer.jwt.claims.sub).toBe('sub-prod-token');
  });

  it('quota spent → 402 QUOTA_EXCEEDED without calling the model', async () => {
    ddb.on(GetCommand).resolves({});
    ddb.on(UpdateCommand).rejects(new ConditionalCheckFailedException({ message: 'x', $metadata: {} }));
    const res = await legacyExtract(event('dev-token'));
    expect(res.statusCode).toBe(402);
    expect(JSON.parse(res.body).errorCode).toBe('QUOTA_EXCEEDED');
    expect(extract).not.toHaveBeenCalled();
  });

  describe('prod-pool callers are not metered against the dev tables (X-005)', () => {
    it('a prod token never reads dev Subscriptions or counts dev Usage, so a paying prod user is not cut off at the dev Free limit', async () => {
      ddb.on(GetCommand).resolves({});
      ddb.on(UpdateCommand).rejects(new ConditionalCheckFailedException({ message: 'quota spent', $metadata: {} }));
      extract.mockResolvedValue({ statusCode: 200, body: '{"success":true}' });

      const res = await legacyExtract(event('prod-token'));

      expect(res.statusCode).toBe(200);
      expect(ddb.commandCalls(GetCommand)).toHaveLength(0);
      expect(ddb.commandCalls(UpdateCommand)).toHaveLength(0);
    });

    it('a failed extraction for a prod token returns the error without touching Usage', async () => {
      extract.mockResolvedValue({ statusCode: 500, body: '{}' });
      const res = await legacyExtract(event('prod-token'));
      expect(res.statusCode).toBe(500);
      expect(ddb.commandCalls(UpdateCommand)).toHaveLength(0);
    });

    it('a dev-pool token is still metered', async () => {
      ddb.on(GetCommand).resolves({});
      ddb.on(UpdateCommand).resolves({ Attributes: { count: 1 } });
      extract.mockResolvedValue({ statusCode: 200, body: '{}' });
      await legacyExtract(event('dev-token'));
      expect(ddb.commandCalls(UpdateCommand)).toHaveLength(1);
    });
  });

  it('refunds the unit when extraction fails', async () => {
    ddb.on(GetCommand).resolves({});
    ddb.on(UpdateCommand).resolves({ Attributes: { count: 1 } });
    extract.mockResolvedValue({ statusCode: 500, body: '{}' });
    await legacyExtract(event('dev-token'));
    expect(ddb.commandCalls(UpdateCommand).map((c) => c.args[0].input.ExpressionAttributeValues![':n'])).toEqual([1, -1]);
  });
});
