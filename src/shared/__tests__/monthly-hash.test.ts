import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBDocumentClient, QueryCommand, PutCommand, DeleteCommand } from '@aws-sdk/lib-dynamodb';

vi.stubEnv('DAILY_STATS_TABLE', 'test-daily-stats');

const ddbMock = mockClient(DynamoDBDocumentClient);

const { recomputeMonthlyHashes } = await import('../monthly-hash.ts');

beforeEach(() => {
  ddbMock.reset();
  ddbMock.on(PutCommand).resolves({});
  ddbMock.on(DeleteCommand).resolves({});
});

describe('recomputeMonthlyHashes', () => {
  it('queries daily records for the month, computes monthHash, writes PutCommand', async () => {
    ddbMock.on(QueryCommand).resolves({
      Items: [
        { date: '2026-04-10', tradeHash: 'hash-a' },
        { date: '2026-04-15', tradeHash: 'hash-b' },
      ],
    });

    await recomputeMonthlyHashes('user-1', 'acc-1', new Set(['2026-04']));

    // Verify QueryCommand was called with correct range
    const queryCalls = ddbMock.commandCalls(QueryCommand);
    expect(queryCalls).toHaveLength(1);
    const queryInput = queryCalls[0].args[0].input;
    expect(queryInput.TableName).toBe('test-daily-stats');
    expect(queryInput.ExpressionAttributeValues![':userId']).toBe('user-1');
    expect(queryInput.ExpressionAttributeValues![':skStart']).toBe('acc-1#2026-04-01');
    expect(queryInput.ExpressionAttributeValues![':skEnd']).toBe('acc-1#2026-04-31');

    // Verify PutCommand was called with monthly hash record
    const putCalls = ddbMock.commandCalls(PutCommand);
    expect(putCalls).toHaveLength(1);
    const putItem = putCalls[0].args[0].input.Item!;
    expect(putItem.userId).toBe('user-1');
    expect(putItem.sk).toBe('acc-1#MONTH#2026-04');
    expect(putItem.accountId).toBe('acc-1');
    expect(putItem.month).toBe('2026-04');
    expect(putItem.monthHash).toHaveLength(64);
    expect(putItem.lastUpdated).toBeDefined();
  });

  it('deletes monthly record when no daily records exist for that month', async () => {
    ddbMock.on(QueryCommand).resolves({ Items: [] });

    await recomputeMonthlyHashes('user-1', 'acc-1', new Set(['2026-04']));

    // Should not write a PutCommand
    expect(ddbMock.commandCalls(PutCommand)).toHaveLength(0);

    // Should delete the monthly hash record
    const deleteCalls = ddbMock.commandCalls(DeleteCommand);
    expect(deleteCalls).toHaveLength(1);
    expect(deleteCalls[0].args[0].input.Key).toEqual({
      userId: 'user-1',
      sk: 'acc-1#MONTH#2026-04',
    });
  });

  it('handles multiple months in one call', async () => {
    ddbMock.on(QueryCommand)
      .resolvesOnce({
        Items: [{ date: '2026-03-05', tradeHash: 'hash-march' }],
      })
      .resolvesOnce({
        Items: [{ date: '2026-04-10', tradeHash: 'hash-april' }],
      });

    await recomputeMonthlyHashes('user-1', 'acc-1', new Set(['2026-03', '2026-04']));

    // Should have queried twice
    expect(ddbMock.commandCalls(QueryCommand)).toHaveLength(2);

    // Should have written two monthly hash records
    const putCalls = ddbMock.commandCalls(PutCommand);
    expect(putCalls).toHaveLength(2);

    const sks = putCalls.map(c => c.args[0].input.Item!.sk);
    expect(sks).toContain('acc-1#MONTH#2026-03');
    expect(sks).toContain('acc-1#MONTH#2026-04');
  });

  it('is idempotent: calling twice with same data produces same monthHash', async () => {
    const items = [
      { date: '2026-04-10', tradeHash: 'hash-a' },
      { date: '2026-04-15', tradeHash: 'hash-b' },
    ];
    ddbMock.on(QueryCommand).resolves({ Items: items });

    await recomputeMonthlyHashes('user-1', 'acc-1', new Set(['2026-04']));
    const firstHash = ddbMock.commandCalls(PutCommand)[0].args[0].input.Item!.monthHash;

    ddbMock.reset();
    ddbMock.on(QueryCommand).resolves({ Items: items });
    ddbMock.on(PutCommand).resolves({});

    await recomputeMonthlyHashes('user-1', 'acc-1', new Set(['2026-04']));
    const secondHash = ddbMock.commandCalls(PutCommand)[0].args[0].input.Item!.monthHash;

    expect(firstHash).toBe(secondHash);
  });

  it('filters out records without tradeHash or date', async () => {
    ddbMock.on(QueryCommand).resolves({
      Items: [
        { date: '2026-04-10', tradeHash: 'hash-a' },
        { date: '2026-04-11' }, // missing tradeHash
        { tradeHash: 'hash-c' }, // missing date
        { date: '2026-04-12', tradeHash: 'hash-d' },
      ],
    });

    await recomputeMonthlyHashes('user-1', 'acc-1', new Set(['2026-04']));

    // Should still write (2 valid records)
    const putCalls = ddbMock.commandCalls(PutCommand);
    expect(putCalls).toHaveLength(1);
    expect(putCalls[0].args[0].input.Item!.monthHash).toHaveLength(64);
  });

  it('deletes monthly record when all daily records lack tradeHash', async () => {
    ddbMock.on(QueryCommand).resolves({
      Items: [
        { date: '2026-04-10' }, // missing tradeHash
        { date: '2026-04-11' }, // missing tradeHash
      ],
    });

    await recomputeMonthlyHashes('user-1', 'acc-1', new Set(['2026-04']));

    // All records filtered out → should delete
    expect(ddbMock.commandCalls(PutCommand)).toHaveLength(0);
    expect(ddbMock.commandCalls(DeleteCommand)).toHaveLength(1);
  });
});
