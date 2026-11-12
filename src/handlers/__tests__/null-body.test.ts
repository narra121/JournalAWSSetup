import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { mockClient } from 'aws-sdk-client-mock';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../shared/subscription', () => ({ checkSubscription: vi.fn().mockResolvedValue(null) }));
mockClient(DynamoDBDocumentClient).onAnyCommand().resolves({});

const HANDLERS = [
  'create-goal', 'update-goal', 'create-rule', 'update-rule', 'update-account-status', 'update-user-profile',
  'create-stripe-checkout', 'update-account', 'create-account', 'update-user-notifications', 'update-user-preferences',
  'update-saved-options', 'create-trade', 'update-trade', 'sync-trades',
];

const event = (body: string) =>
  ({
    version: '2.0',
    headers: {},
    pathParameters: { goalId: 'g', ruleId: 'r', accountId: 'a', tradeId: 't' },
    requestContext: { requestId: 'r1', http: { method: 'POST' }, authorizer: { jwt: { claims: { sub: 'u1', email: 'u@x.y' } } } },
    body,
    isBase64Encoded: false,
  }) as any;

describe('a JSON null / array / scalar body is a 400, never a 500 (B-052)', () => {
  it.each(HANDLERS)('%s', async (name) => {
    const { handler } = await import(`../${name}/app.ts`);
    for (const body of ['null', '[]', '5', '"text"']) {
      const res = (await handler(event(body), {} as any, () => {})) as any;
      expect(res.statusCode, `${name} body ${body}`).toBe(400);
    }
  });
});
