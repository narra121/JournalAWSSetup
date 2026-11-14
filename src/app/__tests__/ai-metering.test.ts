import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';
import { mockClient } from 'aws-sdk-client-mock';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.stubEnv('USER_POOL_ID', 'us-east-1_test');
vi.stubEnv('USER_POOL_CLIENT_ID', 'client');
vi.stubEnv('ALLOWED_ORIGINS', 'https://dev.tradequt.com');
vi.stubEnv('SUBSCRIPTIONS_TABLE', 'test-subs');
vi.stubEnv('USAGE_TABLE', 'test-usage');
vi.stubEnv('GEMINI_API_KEY_PARAM', '/test/gemini-key');
vi.spyOn(console, 'error').mockImplementation(() => undefined);
vi.spyOn(console, 'warn').mockImplementation(() => undefined);
vi.spyOn(console, 'log').mockImplementation(() => undefined);

const ddbMock = mockClient(DynamoDBDocumentClient);
const ssmMock = mockClient(SSMClient);
const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);
const { createApp } = await import('../app');
const { setTokenVerifier } = await import('../auth/cognito');

setTokenVerifier({ verify: async () => ({ sub: 'user-1', email: 'a@example.com' }) });
const app = createApp();

const post = (path: string, body: unknown) =>
  app.request(path, {
    method: 'POST',
    headers: { origin: 'https://dev.tradequt.com', 'content-type': 'application/json', authorization: 'Bearer valid' },
    body: JSON.stringify(body),
  });

const usageCalls = () => ddbMock.commandCalls(UpdateCommand).map((c) => c.args[0].input);

beforeEach(() => {
  ddbMock.reset();
  ssmMock.reset();
  fetchMock.mockReset();
  ssmMock.on(GetParameterCommand).resolves({ Parameter: { Value: 'key' } });
  ddbMock.on(GetCommand, { TableName: 'test-subs' }).resolves({ Item: { userId: 'user-1', status: 'trial', trialEnd: new Date(Date.now() + 86400000).toISOString(), plansVersion: 2 } });
  ddbMock.on(UpdateCommand).resolves({ Attributes: { count: 1 } });
});

describe('POST /v1/enhance-text is metered (BE-008)', () => {
  it('consumes one ai_enhance unit per call', async () => {
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ candidates: [{ finishReason: 'STOP', content: { parts: [{ text: 'Fixed.' }] } }] }) });
    const res = await post('/v1/enhance-text', { text: 'fix me' });

    expect(res.status).toBe(200);
    expect(usageCalls()).toHaveLength(1);
    expect(usageCalls()[0].Key!.sk).toMatch(/^\d{4}-\d{2}#ai_enhance$/);
    expect(usageCalls()[0].ExpressionAttributeValues![':n']).toBe(1);
  });

  it('402 QUOTA_EXCEEDED once the monthly limit is used, and Gemini is never called', async () => {
    ddbMock.on(UpdateCommand).rejects(new ConditionalCheckFailedException({ message: 'The conditional request failed', $metadata: {} }));
    const res = await post('/v1/enhance-text', { text: 'fix me' });
    const body = await res.json();

    expect(res.status).toBe(402);
    expect(body.error).toMatchObject({ code: 'QUOTA_EXCEEDED', feature: 'ai_enhance', limit: 500, plan: 'trial' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refunds the unit when the model call fails', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 500, statusText: 'err', text: async () => 'boom' });
    const res = await post('/v1/enhance-text', { text: 'fix me' });

    expect(res.status).toBe(502);
    expect(usageCalls().map((c) => c.ExpressionAttributeValues![':n'])).toEqual([1, -1]);
  });
});

describe('POST /v1/trades/extract is charged per image (BE-099)', () => {
  const okReply = { ok: true, json: async () => ({ candidates: [{ content: { parts: [{ text: 'symbol,side,quantity,openDate,closeDate,entryPrice,exitPrice,stopLoss,takeProfit,pnl\nAAPL,BUY,1,2026-01-01T10:00:00,2026-01-01T11:00:00,1,2,0,0,1' }] } }] }) };
  const units = () => usageCalls().map((c) => c.ExpressionAttributeValues![':n']);

  it('three images consume three units', async () => {
    fetchMock.mockResolvedValue(okReply);
    const res = await post('/v1/trades/extract', { images: ['aGVsbG8=', 'aGVsbG8=', 'aGVsbG8='] });
    expect(res.status).toBe(200);
    expect(units()).toEqual([3]);
  });

  it('a text request or one image is one unit', async () => {
    fetchMock.mockResolvedValue(okReply);
    await post('/v1/trades/extract', { textContent: 'AAPL buy 1' });
    await post('/v1/trades/extract', { imageBase64: 'aGVsbG8=' });
    expect(units()).toEqual([1, 1]);
  });

  it('a malformed images list is a 400 and the units are refunded', async () => {
    const res = await post('/v1/trades/extract', { images: ['aGVsbG8=', 42] });
    expect(res.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(units()).toEqual([2, -2]);
  });
});

