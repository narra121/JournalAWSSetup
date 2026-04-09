import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBDocumentClient, GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';

vi.stubEnv('RATE_LIMIT_TABLE', 'test-rate-limit');

const ddbMock = mockClient(DynamoDBDocumentClient);

const { checkRateLimit } = await import('../rateLimit.ts');

beforeEach(() => {
  ddbMock.reset();
  ddbMock.on(PutCommand).resolves({});
});

describe('checkRateLimit', () => {
  it('allows request when no existing record', async () => {
    ddbMock.on(GetCommand).resolves({ Item: undefined });

    const result = await checkRateLimit({ key: 'test:user@example.com', limit: 5, windowSeconds: 3600 });

    expect(result.allowed).toBe(true);
  });

  it('increments count and writes to DynamoDB', async () => {
    ddbMock.on(GetCommand).resolves({ Item: undefined });

    await checkRateLimit({ key: 'test:user@example.com', limit: 5, windowSeconds: 3600 });

    const putCalls = ddbMock.commandCalls(PutCommand);
    expect(putCalls).toHaveLength(1);
    expect(putCalls[0].args[0].input.Item?.count).toBe(1);
    expect(putCalls[0].args[0].input.Item?.key).toBe('test:user@example.com');
  });

  it('allows request when under limit', async () => {
    ddbMock.on(GetCommand).resolves({ Item: { key: 'test:key', count: 3, ttl: Math.floor(Date.now() / 1000) + 100 } });

    const result = await checkRateLimit({ key: 'test:key', limit: 5, windowSeconds: 3600 });

    expect(result.allowed).toBe(true);
  });

  it('blocks request when at limit', async () => {
    const ttl = Math.floor(Date.now() / 1000) + 500;
    ddbMock.on(GetCommand).resolves({ Item: { key: 'test:key', count: 5, ttl } });

    const result = await checkRateLimit({ key: 'test:key', limit: 5, windowSeconds: 3600 });

    expect(result.allowed).toBe(false);
    expect(result.retryAfter).toBeGreaterThan(0);
  });

  it('blocks request when over limit', async () => {
    const ttl = Math.floor(Date.now() / 1000) + 200;
    ddbMock.on(GetCommand).resolves({ Item: { key: 'test:key', count: 10, ttl } });

    const result = await checkRateLimit({ key: 'test:key', limit: 5, windowSeconds: 3600 });

    expect(result.allowed).toBe(false);
  });

  it('returns windowSeconds as retryAfter when ttl is missing', async () => {
    ddbMock.on(GetCommand).resolves({ Item: { key: 'test:key', count: 5 } });

    const result = await checkRateLimit({ key: 'test:key', limit: 5, windowSeconds: 3600 });

    expect(result.allowed).toBe(false);
    expect(result.retryAfter).toBe(3600);
  });

  it('does not write to DynamoDB when rate limited', async () => {
    ddbMock.on(GetCommand).resolves({ Item: { key: 'test:key', count: 5, ttl: Math.floor(Date.now() / 1000) + 100 } });

    await checkRateLimit({ key: 'test:key', limit: 5, windowSeconds: 3600 });

    const putCalls = ddbMock.commandCalls(PutCommand);
    expect(putCalls).toHaveLength(0);
  });

  it('treats count=0 from DynamoDB as allowed', async () => {
    ddbMock.on(GetCommand).resolves({ Item: { key: 'test:key', count: 0, ttl: Math.floor(Date.now() / 1000) + 100 } });

    const result = await checkRateLimit({ key: 'test:key', limit: 5, windowSeconds: 3600 });

    expect(result.allowed).toBe(true);
  });
});
