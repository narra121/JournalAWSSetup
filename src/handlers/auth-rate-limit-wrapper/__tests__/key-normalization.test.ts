import { DynamoDBDocumentClient, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { mockClient } from 'aws-sdk-client-mock';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.stubEnv('RATE_LIMIT_TABLE', 'limits');
const ddb = mockClient(DynamoDBDocumentClient);
const { checkRateLimit } = await import('../rateLimit');

beforeEach(() => {
  ddb.reset();
  ddb.on(UpdateCommand).resolves({ Attributes: { count: 1, ttl: Math.floor(Date.now() / 1000) + 100 } });
});

describe('checkRateLimit key', () => {
  it('upper-case and padded e-mails share one bucket with the plain form', async () => {
    await checkRateLimit({ key: 'login:Victim@Example.COM ', limit: 5, windowSeconds: 60 });
    await checkRateLimit({ key: 'login:victim@example.com', limit: 5, windowSeconds: 60 });
    const keys = ddb.commandCalls(UpdateCommand).map((c) => c.args[0].input.Key!.key);
    expect(keys).toEqual(['login:victim@example.com', 'login:victim@example.com']);
  });
});
