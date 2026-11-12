import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { mockClient } from 'aws-sdk-client-mock';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.stubEnv('SUBSCRIPTIONS_TABLE', 'subs');
vi.stubEnv('USAGE_TABLE', 'usage');

const extract = vi.fn();
vi.mock('../../handlers/extract-trades/app', () => ({ handler: (...a: any[]) => extract(...a) }));

const ddb = mockClient(DynamoDBDocumentClient);
const { legacyExtract, setLegacyVerifier } = await import('../legacy-extract');

const event = (token?: string) => ({ headers: token ? { authorization: `Bearer ${token}` } : {}, requestContext: {}, body: '{}' });

beforeEach(() => {
  ddb.reset();
  extract.mockReset();
  setLegacyVerifier({ verify: async (t) => (t === 'dev-token' || t === 'prod-token' ? { sub: `sub-${t}` } : Promise.reject(new Error('bad'))) });
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

  it('refunds the unit when extraction fails', async () => {
    ddb.on(GetCommand).resolves({});
    ddb.on(UpdateCommand).resolves({ Attributes: { count: 1 } });
    extract.mockResolvedValue({ statusCode: 500, body: '{}' });
    await legacyExtract(event('dev-token'));
    expect(ddb.commandCalls(UpdateCommand).map((c) => c.args[0].input.ExpressionAttributeValues![':n'])).toEqual([1, -1]);
  });
});
