import { DynamoDBDocumentClient, GetCommand } from '@aws-sdk/lib-dynamodb';
import { mockClient } from 'aws-sdk-client-mock';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.stubEnv('TRADES_TABLE', 'trades');
const { handler } = await import('../app.ts');
const ddb = mockClient(DynamoDBDocumentClient);

const event = (claims: any, tradeId?: string) =>
  ({ requestContext: { requestId: 'r', authorizer: { jwt: { claims } } }, pathParameters: tradeId ? { tradeId } : undefined }) as any;
const call = async (e: any) => (await handler(e, {} as any, () => {})) as any;

beforeEach(() => {
  ddb.reset();
});

describe('get-trade', () => {
  it('returns the caller\'s trade, keyed by the verified userId', async () => {
    ddb.on(GetCommand).resolves({ Item: { userId: 'u1', tradeId: 't1', symbol: 'XAUUSD' } });
    const res = await call(event({ sub: 'u1' }, 't1'));
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).data.trade.symbol).toBe('XAUUSD');
    expect(ddb.commandCalls(GetCommand)[0].args[0].input).toMatchObject({ TableName: 'trades', Key: { userId: 'u1', tradeId: 't1' } });
  });

  it('404 when the trade does not exist (or belongs to someone else)', async () => {
    ddb.on(GetCommand).resolves({});
    expect((await call(event({ sub: 'u1' }, 'nope'))).statusCode).toBe(404);
  });

  it('401 without claims, 400 without a tradeId', async () => {
    expect((await call(event({}, 't1'))).statusCode).toBe(401);
    expect((await call(event({ sub: 'u1' }))).statusCode).toBe(400);
  });

  it('500 envelope when DynamoDB fails', async () => {
    ddb.on(GetCommand).rejects(new Error('boom'));
    expect((await call(event({ sub: 'u1' }, 't1'))).statusCode).toBe(500);
  });
});
