import { describe, it, expect, beforeEach, vi } from 'vitest';
import { batchWritePutAll } from '../batchWrite.js';

// ─── Helpers ────────────────────────────────────────────────────

function makeMockDdb() {
  return {
    send: vi.fn(),
  };
}

function makeItems(count: number) {
  return Array.from({ length: count }, (_, i) => ({ id: `item-${i}`, value: i }));
}

// ─── Tests ──────────────────────────────────────────────────────

describe('batchWritePutAll', () => {
  let mockDdb: ReturnType<typeof makeMockDdb>;

  beforeEach(() => {
    mockDdb = makeMockDdb();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('processes all items on first try when none are unprocessed', async () => {
    mockDdb.send.mockResolvedValueOnce({
      UnprocessedItems: {},
    });

    const items = makeItems(3);
    const promise = batchWritePutAll({
      ddb: mockDdb,
      tableName: 'test-table',
      items,
    });

    await vi.runAllTimersAsync();
    await promise;

    expect(mockDdb.send).toHaveBeenCalledTimes(1);
    const command = mockDdb.send.mock.calls[0][0];
    expect(command.input.RequestItems['test-table']).toHaveLength(3);
  });

  it('retries unprocessed items with exponential backoff', async () => {
    const items = makeItems(2);

    // First call: one item unprocessed
    mockDdb.send.mockResolvedValueOnce({
      UnprocessedItems: {
        'test-table': [
          { PutRequest: { Item: items[1] } },
        ],
      },
    });
    // Second call: all processed
    mockDdb.send.mockResolvedValueOnce({
      UnprocessedItems: {},
    });

    const promise = batchWritePutAll({
      ddb: mockDdb,
      tableName: 'test-table',
      items,
      baseDelayMs: 100,
    });

    // Advance timers to process the retry delay
    await vi.runAllTimersAsync();
    await promise;

    expect(mockDdb.send).toHaveBeenCalledTimes(2);
    // Second call should only have the 1 unprocessed item
    const secondCommand = mockDdb.send.mock.calls[1][0];
    expect(secondCommand.input.RequestItems['test-table']).toHaveLength(1);
  });

  it('throws after maxRetries exceeded', async () => {
    vi.useRealTimers();

    const items = makeItems(1);

    // Always return unprocessed items
    mockDdb.send.mockResolvedValue({
      UnprocessedItems: {
        'test-table': [
          { PutRequest: { Item: items[0] } },
        ],
      },
    });

    await expect(
      batchWritePutAll({
        ddb: mockDdb,
        tableName: 'test-table',
        items,
        maxRetries: 2,
        baseDelayMs: 1,
      }),
    ).rejects.toThrow(/did not process all items after 2 retries/i);
  });

  it('does nothing for empty items array', async () => {
    await batchWritePutAll({
      ddb: mockDdb,
      tableName: 'test-table',
      items: [],
    });

    expect(mockDdb.send).not.toHaveBeenCalled();
  });

  it('chunks items into batches of 25 when more than 25 items', async () => {
    vi.useRealTimers();

    mockDdb.send.mockResolvedValue({ UnprocessedItems: {} });

    const items = makeItems(60); // 3 chunks: 25 + 25 + 10
    await batchWritePutAll({
      ddb: mockDdb,
      tableName: 'test-table',
      items,
    });

    // Should have been called 3 times (one per chunk, in parallel)
    expect(mockDdb.send).toHaveBeenCalledTimes(3);

    const callSizes = mockDdb.send.mock.calls.map(
      (call: any) => call[0].input.RequestItems['test-table'].length
    );
    callSizes.sort((a: number, b: number) => b - a);
    expect(callSizes).toEqual([25, 25, 10]);
  });

  it('handles exactly 25 items in a single batch', async () => {
    mockDdb.send.mockResolvedValueOnce({ UnprocessedItems: {} });

    const items = makeItems(25);
    const promise = batchWritePutAll({
      ddb: mockDdb,
      tableName: 'test-table',
      items,
    });

    await vi.runAllTimersAsync();
    await promise;

    expect(mockDdb.send).toHaveBeenCalledTimes(1);
    expect(mockDdb.send.mock.calls[0][0].input.RequestItems['test-table']).toHaveLength(25);
  });

  it('calls log.warn on retries when logger provided', async () => {
    const items = makeItems(1);
    const log = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };

    // First call: unprocessed, second call: success
    mockDdb.send.mockResolvedValueOnce({
      UnprocessedItems: {
        'test-table': [
          { PutRequest: { Item: items[0] } },
        ],
      },
    });
    mockDdb.send.mockResolvedValueOnce({
      UnprocessedItems: {},
    });

    const promise = batchWritePutAll({
      ddb: mockDdb,
      tableName: 'test-table',
      items,
      log,
      baseDelayMs: 10,
    });

    await vi.runAllTimersAsync();
    await promise;

    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(log.warn).toHaveBeenCalledWith(
      'batch write unprocessed items',
      expect.objectContaining({
        tableName: 'test-table',
        attempt: 1,
        remaining: 1,
      }),
    );
  });
});
