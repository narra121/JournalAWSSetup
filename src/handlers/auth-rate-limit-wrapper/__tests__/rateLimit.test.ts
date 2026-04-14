import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBDocumentClient, UpdateCommand } from '@aws-sdk/lib-dynamodb';

vi.stubEnv('RATE_LIMIT_TABLE', 'test-rate-limit');

const ddbMock = mockClient(DynamoDBDocumentClient);

const { checkRateLimit } = await import('../rateLimit.ts');

beforeEach(() => {
  ddbMock.reset();
});

describe('checkRateLimit', () => {
  it('allows request when count is 1 (first request)', async () => {
    const ttl = Math.floor(Date.now() / 1000) + 3600;
    ddbMock.on(UpdateCommand).resolves({ Attributes: { key: 'test:user@example.com', count: 1, ttl } });

    const result = await checkRateLimit({ key: 'test:user@example.com', limit: 5, windowSeconds: 3600 });

    expect(result.allowed).toBe(true);
  });

  it('sends atomic UpdateCommand with ADD count and SET ttl', async () => {
    const ttl = Math.floor(Date.now() / 1000) + 3600;
    ddbMock.on(UpdateCommand).resolves({ Attributes: { key: 'test:user@example.com', count: 1, ttl } });

    await checkRateLimit({ key: 'test:user@example.com', limit: 5, windowSeconds: 3600 });

    const updateCalls = ddbMock.commandCalls(UpdateCommand);
    expect(updateCalls).toHaveLength(1);
    expect(updateCalls[0].args[0].input.UpdateExpression).toContain('ADD');
    expect(updateCalls[0].args[0].input.ReturnValues).toBe('ALL_NEW');
  });

  it('allows request when under limit', async () => {
    const ttl = Math.floor(Date.now() / 1000) + 100;
    ddbMock.on(UpdateCommand).resolves({ Attributes: { key: 'test:key', count: 3, ttl } });

    const result = await checkRateLimit({ key: 'test:key', limit: 5, windowSeconds: 3600 });

    expect(result.allowed).toBe(true);
  });

  it('allows request when at limit (count == limit)', async () => {
    const ttl = Math.floor(Date.now() / 1000) + 500;
    ddbMock.on(UpdateCommand).resolves({ Attributes: { key: 'test:key', count: 5, ttl } });

    const result = await checkRateLimit({ key: 'test:key', limit: 5, windowSeconds: 3600 });

    expect(result.allowed).toBe(true);
  });

  it('blocks request when over limit', async () => {
    const ttl = Math.floor(Date.now() / 1000) + 200;
    ddbMock.on(UpdateCommand).resolves({ Attributes: { key: 'test:key', count: 6, ttl } });

    const result = await checkRateLimit({ key: 'test:key', limit: 5, windowSeconds: 3600 });

    expect(result.allowed).toBe(false);
    expect(result.retryAfter).toBeGreaterThan(0);
  });

  it('blocks request when well over limit', async () => {
    const ttl = Math.floor(Date.now() / 1000) + 200;
    ddbMock.on(UpdateCommand).resolves({ Attributes: { key: 'test:key', count: 10, ttl } });

    const result = await checkRateLimit({ key: 'test:key', limit: 5, windowSeconds: 3600 });

    expect(result.allowed).toBe(false);
  });

  it('resets stale item when TTL is in the past', async () => {
    const staleTtl = Math.floor(Date.now() / 1000) - 100; // expired
    const freshTtl = Math.floor(Date.now() / 1000) + 3600;
    // First call returns stale item, second call (reset) returns fresh item
    ddbMock.on(UpdateCommand)
      .resolvesOnce({ Attributes: { key: 'test:key', count: 50, ttl: staleTtl } })
      .resolvesOnce({ Attributes: { key: 'test:key', count: 1, ttl: freshTtl } });

    const result = await checkRateLimit({ key: 'test:key', limit: 5, windowSeconds: 3600 });

    expect(result.allowed).toBe(true);
    // Should have sent 2 UpdateCommands (atomic increment + reset)
    const updateCalls = ddbMock.commandCalls(UpdateCommand);
    expect(updateCalls).toHaveLength(2);
  });

  it('returns retryAfter based on TTL', async () => {
    const ttl = Math.floor(Date.now() / 1000) + 500;
    ddbMock.on(UpdateCommand).resolves({ Attributes: { key: 'test:key', count: 11, ttl } });

    const result = await checkRateLimit({ key: 'test:key', limit: 5, windowSeconds: 3600 });

    expect(result.allowed).toBe(false);
    expect(result.retryAfter).toBeGreaterThan(0);
    expect(result.retryAfter).toBeLessThanOrEqual(500);
  });
});
