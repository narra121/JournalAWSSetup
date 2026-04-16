import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { batchWritePutAll, batchWriteDeleteAll } from '../batchWrite.js';

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

// ─── batchWriteDeleteAll ───────────────────────────────────────

function makeKeys(count: number) {
  return Array.from({ length: count }, (_, i) => ({ pk: `pk-${i}`, sk: `sk-${i}` }));
}

describe('batchWriteDeleteAll', () => {
  let mockDdb: ReturnType<typeof makeMockDdb>;

  beforeEach(() => {
    mockDdb = makeMockDdb();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('deletes all keys on first try when none are unprocessed', async () => {
    mockDdb.send.mockResolvedValueOnce({
      UnprocessedItems: {},
    });

    const keys = makeKeys(3);
    const promise = batchWriteDeleteAll({
      ddb: mockDdb,
      tableName: 'test-table',
      keys,
    });

    await vi.runAllTimersAsync();
    await promise;

    expect(mockDdb.send).toHaveBeenCalledTimes(1);
    const command = mockDdb.send.mock.calls[0][0];
    expect(command.input.RequestItems['test-table']).toHaveLength(3);
    // Verify it uses DeleteRequest, not PutRequest
    expect(command.input.RequestItems['test-table'][0]).toHaveProperty('DeleteRequest');
    expect(command.input.RequestItems['test-table'][0].DeleteRequest.Key).toEqual(keys[0]);
  });

  it('retries unprocessed items with exponential backoff', async () => {
    const keys = makeKeys(2);

    // First call: one key unprocessed
    mockDdb.send.mockResolvedValueOnce({
      UnprocessedItems: {
        'test-table': [
          { DeleteRequest: { Key: keys[1] } },
        ],
      },
    });
    // Second call: all processed
    mockDdb.send.mockResolvedValueOnce({
      UnprocessedItems: {},
    });

    const promise = batchWriteDeleteAll({
      ddb: mockDdb,
      tableName: 'test-table',
      keys,
      baseDelayMs: 100,
    });

    await vi.runAllTimersAsync();
    await promise;

    expect(mockDdb.send).toHaveBeenCalledTimes(2);
    // Second call should only have the 1 unprocessed key
    const secondCommand = mockDdb.send.mock.calls[1][0];
    expect(secondCommand.input.RequestItems['test-table']).toHaveLength(1);
    expect(secondCommand.input.RequestItems['test-table'][0].DeleteRequest.Key).toEqual(keys[1]);
  });

  it('throws after maxRetries exceeded', async () => {
    vi.useRealTimers();

    const keys = makeKeys(1);

    // Always return unprocessed items
    mockDdb.send.mockResolvedValue({
      UnprocessedItems: {
        'test-table': [
          { DeleteRequest: { Key: keys[0] } },
        ],
      },
    });

    await expect(
      batchWriteDeleteAll({
        ddb: mockDdb,
        tableName: 'test-table',
        keys,
        maxRetries: 2,
        baseDelayMs: 1,
      }),
    ).rejects.toThrow(/did not process all items after 2 retries/i);
  });

  it('does nothing for empty keys array', async () => {
    await batchWriteDeleteAll({
      ddb: mockDdb,
      tableName: 'test-table',
      keys: [],
    });

    expect(mockDdb.send).not.toHaveBeenCalled();
  });

  it('chunks keys into batches of 25 when more than 25 keys', async () => {
    vi.useRealTimers();

    mockDdb.send.mockResolvedValue({ UnprocessedItems: {} });

    const keys = makeKeys(60); // 3 chunks: 25 + 25 + 10
    await batchWriteDeleteAll({
      ddb: mockDdb,
      tableName: 'test-table',
      keys,
    });

    // Should have been called 3 times (one per chunk, in parallel)
    expect(mockDdb.send).toHaveBeenCalledTimes(3);

    const callSizes = mockDdb.send.mock.calls.map(
      (call: any) => call[0].input.RequestItems['test-table'].length
    );
    callSizes.sort((a: number, b: number) => b - a);
    expect(callSizes).toEqual([25, 25, 10]);
  });

  it('handles exactly 25 keys in a single batch', async () => {
    mockDdb.send.mockResolvedValueOnce({ UnprocessedItems: {} });

    const keys = makeKeys(25);
    const promise = batchWriteDeleteAll({
      ddb: mockDdb,
      tableName: 'test-table',
      keys,
    });

    await vi.runAllTimersAsync();
    await promise;

    expect(mockDdb.send).toHaveBeenCalledTimes(1);
    expect(mockDdb.send.mock.calls[0][0].input.RequestItems['test-table']).toHaveLength(25);
  });

  it('calls log.warn on retries when logger provided', async () => {
    const keys = makeKeys(1);
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
          { DeleteRequest: { Key: keys[0] } },
        ],
      },
    });
    mockDdb.send.mockResolvedValueOnce({
      UnprocessedItems: {},
    });

    const promise = batchWriteDeleteAll({
      ddb: mockDdb,
      tableName: 'test-table',
      keys,
      log,
      baseDelayMs: 10,
    });

    await vi.runAllTimersAsync();
    await promise;

    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(log.warn).toHaveBeenCalledWith(
      'batch delete unprocessed items',
      expect.objectContaining({
        tableName: 'test-table',
        attempt: 1,
        remaining: 1,
      }),
    );
  });

  it('handles response with no UnprocessedItems key', async () => {
    mockDdb.send.mockResolvedValueOnce({});

    const keys = makeKeys(2);
    const promise = batchWriteDeleteAll({
      ddb: mockDdb,
      tableName: 'test-table',
      keys,
    });

    await vi.runAllTimersAsync();
    await promise;

    expect(mockDdb.send).toHaveBeenCalledTimes(1);
  });

  it('handles response with null UnprocessedItems', async () => {
    mockDdb.send.mockResolvedValueOnce({ UnprocessedItems: null });

    const keys = makeKeys(2);
    const promise = batchWriteDeleteAll({
      ddb: mockDdb,
      tableName: 'test-table',
      keys,
    });

    await vi.runAllTimersAsync();
    await promise;

    expect(mockDdb.send).toHaveBeenCalledTimes(1);
  });
});
