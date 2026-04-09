import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBDocumentClient, QueryCommand, PutCommand, GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import type { DynamoDBStreamEvent } from 'aws-lambda';

// Stub env before importing handler
vi.stubEnv('TRADES_TABLE', 'test-trades');
vi.stubEnv('TRADE_STATS_TABLE', 'test-stats');
vi.stubEnv('ACCOUNTS_TABLE', 'test-accounts');

// Mock DynamoDBDocumentClient (the shared ddb module instantiates at import time)
const ddbMock = mockClient(DynamoDBDocumentClient);

const { handler } = await import('../app.ts');

// ─── Helpers ────────────────────────────────────────────────────

function makeStreamEvent(records: DynamoDBStreamEvent['Records']): DynamoDBStreamEvent {
  return { Records: records };
}

function makeInsertRecord(userId: string, tradeId: string, eventID = 'evt-1') {
  return {
    eventID,
    eventName: 'INSERT' as const,
    dynamodb: {
      NewImage: {
        userId: { S: userId },
        tradeId: { S: tradeId },
        symbol: { S: 'AAPL' },
        side: { S: 'BUY' },
        entryPrice: { N: '100' },
        exitPrice: { N: '110' },
        quantity: { N: '10' },
        accountId: { S: 'acc-1' },
      },
    },
  };
}

function makeRemoveRecord(userId: string, tradeId: string, eventID = 'evt-2') {
  return {
    eventID,
    eventName: 'REMOVE' as const,
    dynamodb: {
      OldImage: {
        userId: { S: userId },
        tradeId: { S: tradeId },
        symbol: { S: 'AAPL' },
        side: { S: 'BUY' },
        entryPrice: { N: '100' },
        exitPrice: { N: '110' },
        quantity: { N: '10' },
        accountId: { S: 'acc-1' },
      },
    },
  };
}

// ─── Tests ──────────────────────────────────────────────────────

beforeEach(() => {
  ddbMock.reset();
  // rebuildStats does a Query on TRADES_TABLE, then Put on STATS_TABLE
  ddbMock.on(QueryCommand).resolves({
    Items: [
      {
        userId: 'user-1',
        tradeId: 'trade-1',
        symbol: 'AAPL',
        side: 'BUY',
        entryPrice: 100,
        exitPrice: 110,
        quantity: 10,
        accountId: 'acc-1',
      },
    ],
    LastEvaluatedKey: undefined,
  });
  ddbMock.on(PutCommand).resolves({});
  ddbMock.on(GetCommand).resolves({
    Item: { initialBalance: 10000 },
  });
  ddbMock.on(UpdateCommand).resolves({});
});

describe('update-stats handler', () => {
  // ── Success ─────────────────────────────────────────────────

  it('processes INSERT event and rebuilds stats', async () => {
    const event = makeStreamEvent([makeInsertRecord('user-1', 'trade-1')]);

    const result = await handler(event, {} as any, () => {});

    // Should have queried trades and written stats
    expect(ddbMock.commandCalls(QueryCommand).length).toBeGreaterThanOrEqual(1);
    expect(ddbMock.commandCalls(PutCommand).length).toBeGreaterThanOrEqual(1);

    const statsItem = ddbMock.commandCalls(PutCommand)[0].args[0].input.Item;
    expect(statsItem.userId).toBe('user-1');
    expect(statsItem.tradeCount).toBe(1);
  });

  it('processes REMOVE event and rebuilds stats from oldImage userId', async () => {
    // After removal, the query returns empty (trade was deleted)
    ddbMock.on(QueryCommand).resolves({
      Items: [],
      LastEvaluatedKey: undefined,
    });

    const event = makeStreamEvent([makeRemoveRecord('user-1', 'trade-1')]);

    const result = await handler(event, {} as any, () => {});

    expect(ddbMock.commandCalls(QueryCommand).length).toBeGreaterThanOrEqual(1);
    const putCalls = ddbMock.commandCalls(PutCommand);
    expect(putCalls.length).toBeGreaterThanOrEqual(1);

    const statsItem = putCalls[0].args[0].input.Item;
    expect(statsItem.userId).toBe('user-1');
    expect(statsItem.tradeCount).toBe(0);
    expect(statsItem.realizedPnL).toBe(0);
  });

  // ── Missing userId ──────────────────────────────────────────

  it('skips record when userId is missing from both images', async () => {
    const event = makeStreamEvent([
      {
        eventID: 'evt-no-user',
        eventName: 'INSERT' as const,
        dynamodb: {
          NewImage: {
            tradeId: { S: 'trade-1' },
          },
        },
      },
    ]);

    const result = await handler(event, {} as any, () => {});

    // Should not have called QueryCommand since there's no userId to rebuild
    expect(ddbMock.commandCalls(QueryCommand)).toHaveLength(0);
  });

  // ── Error handling ──────────────────────────────────────────

  it('returns batchItemFailures when rebuildStats throws', async () => {
    ddbMock.on(QueryCommand).rejects(new Error('DynamoDB error'));

    const event = makeStreamEvent([makeInsertRecord('user-1', 'trade-1', 'evt-fail')]);

    const result = await handler(event, {} as any, () => {}) as any;

    expect(result.batchItemFailures).toBeDefined();
    expect(result.batchItemFailures).toHaveLength(1);
    expect(result.batchItemFailures[0].itemIdentifier).toBe('evt-fail');
  });

  // ── Multiple records ────────────────────────────────────────

  it('processes multiple records in a single event', async () => {
    const event = makeStreamEvent([
      makeInsertRecord('user-1', 'trade-1', 'evt-1'),
      makeInsertRecord('user-2', 'trade-2', 'evt-2'),
    ]);

    // The QueryCommand will return the default mock for both calls
    const result = await handler(event, {} as any, () => {});

    // Should have made at least 2 query calls (one per record/user)
    expect(ddbMock.commandCalls(QueryCommand).length).toBeGreaterThanOrEqual(2);
    expect(ddbMock.commandCalls(PutCommand).length).toBeGreaterThanOrEqual(2);
  });
});
