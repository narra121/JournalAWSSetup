import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBDocumentClient, GetCommand, UpdateCommand, DeleteCommand } from '@aws-sdk/lib-dynamodb';
import { S3Client, DeleteObjectsCommand } from '@aws-sdk/client-s3';
import type { APIGatewayProxyEventV2 } from 'aws-lambda';

vi.stubEnv('TRADES_TABLE', 'test-trades');
vi.stubEnv('IMAGES_BUCKET', 'test-bucket');

vi.mock('../../../shared/subscription', () => ({
  checkSubscription: vi.fn().mockResolvedValue(null),
}));

const ddbMock = mockClient(DynamoDBDocumentClient);
const s3Mock = mockClient(S3Client);
const { handler } = await import('../app.ts');

function makeJwt(sub: string): string {
  return `${btoa(JSON.stringify({ alg: 'RS256' }))}.${btoa(JSON.stringify({ sub }))}.sig`;
}

function makeEvent(tradeId?: string, headers: Record<string, string> = { authorization: `Bearer ${makeJwt('user-1')}` }): APIGatewayProxyEventV2 {
  return {
    version: '2.0',
    routeKey: 'DELETE /trades/{tradeId}',
    rawPath: `/trades/${tradeId || ''}`,
    rawQueryString: '',
    headers,
    pathParameters: tradeId ? { tradeId } : {},
    requestContext: { requestId: 'req-1', http: { method: 'DELETE' } },
    isBase64Encoded: false,
  } as unknown as APIGatewayProxyEventV2;
}

const call = async (e: APIGatewayProxyEventV2) => (await handler(e, {} as any, () => {})) as any;
const stored = { userId: 'user-1', tradeId: 'trade-abc', symbol: 'AAPL', side: 'BUY', pnl: 10, accountId: 'acc-1' };

beforeEach(() => {
  ddbMock.reset();
  s3Mock.reset();
  ddbMock.on(GetCommand).resolves({ Item: { ...stored } });
  ddbMock.on(UpdateCommand).resolves({});
});

describe('delete-trade handler (soft delete)', () => {
  it('marks the trade deleted instead of removing it, and returns the trade', async () => {
    const res = await call(makeEvent('trade-abc'));
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).data.trade).toMatchObject({ tradeId: 'trade-abc', symbol: 'AAPL' });
    expect(ddbMock.commandCalls(DeleteCommand)).toHaveLength(0);
    const input = ddbMock.commandCalls(UpdateCommand)[0].args[0].input;
    expect(input.Key).toEqual({ userId: 'user-1', tradeId: 'trade-abc' });
    expect(input.ConditionExpression).toContain('attribute_not_exists(#deletedAt)');
    expect(input.ExpressionAttributeValues![':ttl']).toBeGreaterThan(Date.now() / 1000 + 29 * 86400);
  });

  it('keeps the screenshots so the trade can be restored', async () => {
    await call(makeEvent('trade-abc'));
    expect(s3Mock.commandCalls(DeleteObjectsCommand)).toHaveLength(0);
  });

  it('moves the idempotency key aside so a re-import creates the trade again', async () => {
    ddbMock.on(GetCommand).resolves({ Item: { ...stored, idempotencyKey: 'k-1' } });
    await call(makeEvent('trade-abc'));
    const input = ddbMock.commandCalls(UpdateCommand)[0].args[0].input;
    expect(input.UpdateExpression).toContain('REMOVE #idem');
    expect(input.ExpressionAttributeValues![':idem']).toBe('k-1');
  });

  it('404 for a missing, already deleted or concurrently deleted trade', async () => {
    ddbMock.on(GetCommand).resolves({});
    expect((await call(makeEvent('nope'))).statusCode).toBe(404);
    ddbMock.on(GetCommand).resolves({ Item: { ...stored, deletedAt: '2026-11-01T00:00:00Z' } });
    expect((await call(makeEvent('trade-abc'))).statusCode).toBe(404);
    ddbMock.on(GetCommand).resolves({ Item: { ...stored } });
    ddbMock.on(UpdateCommand).rejects(Object.assign(new Error('c'), { name: 'ConditionalCheckFailedException' }));
    expect((await call(makeEvent('trade-abc'))).statusCode).toBe(404);
  });

  it('401 without claims, 400 without tradeId, 500 on DynamoDB failure', async () => {
    expect((await call(makeEvent('trade-abc', {}))).statusCode).toBe(401);
    expect((await call(makeEvent())).statusCode).toBe(400);
    ddbMock.on(UpdateCommand).rejects(new Error('boom'));
    expect((await call(makeEvent('trade-abc'))).statusCode).toBe(500);
  });
});
