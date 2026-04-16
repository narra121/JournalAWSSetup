import { describe, it, expect, beforeEach, vi } from 'vitest';

// ─── Env stubs (must be before imports) ────────────────────────

vi.stubEnv('RULES_TABLE', 'test-rules');
vi.stubEnv('SAVED_OPTIONS_TABLE', 'test-saved-options');

// ─── Mocks ─────────────────────────────────────────────────────

const mockSend = vi.fn();
vi.mock('../dynamo', () => ({
  ddb: { send: mockSend },
}));

const mockBatchWritePutAll = vi.fn();
vi.mock('../batchWrite', () => ({
  batchWritePutAll: mockBatchWritePutAll,
}));

vi.mock('uuid', () => ({
  v4: vi.fn(() => 'mock-uuid'),
}));

const {
  createDefaultRules,
  createDefaultSavedOptions,
  DEFAULT_RULES,
  DEFAULT_SAVED_OPTIONS,
} = await import('../user-initialization.js');

// ─── Tests ─────────────────────────────────────────────────────

describe('createDefaultRules', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('creates default rules for a new user (no existing rules)', async () => {
    // QueryCommand returns no items
    mockSend.mockResolvedValueOnce({ Items: [] });
    mockBatchWritePutAll.mockResolvedValueOnce(undefined);

    await createDefaultRules('user-1');

    // Should query for existing rules
    expect(mockSend).toHaveBeenCalledTimes(1);
    const queryInput = mockSend.mock.calls[0][0].input;
    expect(queryInput.TableName).toBe('test-rules');
    expect(queryInput.KeyConditionExpression).toBe('userId = :userId');
    expect(queryInput.ExpressionAttributeValues[':userId']).toBe('user-1');
    expect(queryInput.Limit).toBe(1);

    // Should call batchWritePutAll with default rules
    expect(mockBatchWritePutAll).toHaveBeenCalledTimes(1);
    const batchCall = mockBatchWritePutAll.mock.calls[0][0];
    expect(batchCall.tableName).toBe('test-rules');
    expect(batchCall.items).toHaveLength(DEFAULT_RULES.length);

    // Verify each rule item structure
    const firstItem = batchCall.items[0];
    expect(firstItem.userId).toBe('user-1');
    expect(firstItem.ruleId).toBe('mock-uuid');
    expect(firstItem.rule).toBe(DEFAULT_RULES[0]);
    expect(firstItem.completed).toBe(false);
    expect(firstItem.isActive).toBe(true);
    expect(firstItem.createdAt).toBeDefined();
    expect(firstItem.updatedAt).toBeDefined();
    expect(firstItem.createdAt).toBe(firstItem.updatedAt);
  });

  it('skips creation when user already has rules (idempotent)', async () => {
    // QueryCommand returns existing items
    mockSend.mockResolvedValueOnce({
      Items: [{ userId: 'user-1', ruleId: 'existing-rule' }],
    });

    await createDefaultRules('user-1');

    // Should query but NOT write
    expect(mockSend).toHaveBeenCalledTimes(1);
    expect(mockBatchWritePutAll).not.toHaveBeenCalled();
  });

  it('skips creation when Items is undefined', async () => {
    // QueryCommand returns no Items key at all
    mockSend.mockResolvedValueOnce({});

    await createDefaultRules('user-1');

    // Items is undefined, so `existing.Items && existing.Items.length > 0` is falsy
    // Should proceed to create rules
    expect(mockBatchWritePutAll).toHaveBeenCalledTimes(1);
  });

  it('creates rules with all default rule texts', async () => {
    mockSend.mockResolvedValueOnce({ Items: [] });
    mockBatchWritePutAll.mockResolvedValueOnce(undefined);

    await createDefaultRules('user-2');

    const batchCall = mockBatchWritePutAll.mock.calls[0][0];
    const ruleTexts = batchCall.items.map((item: any) => item.rule);
    expect(ruleTexts).toEqual(DEFAULT_RULES);
  });

  it('passes the ddb client to batchWritePutAll', async () => {
    mockSend.mockResolvedValueOnce({ Items: [] });
    mockBatchWritePutAll.mockResolvedValueOnce(undefined);

    await createDefaultRules('user-1');

    const batchCall = mockBatchWritePutAll.mock.calls[0][0];
    expect(batchCall.ddb).toBeDefined();
    expect(batchCall.ddb.send).toBe(mockSend);
  });
});

describe('createDefaultSavedOptions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('creates default saved options for a new user', async () => {
    // QueryCommand returns no items
    mockSend.mockResolvedValueOnce({ Items: [] });
    // PutCommand succeeds
    mockSend.mockResolvedValueOnce({});

    await createDefaultSavedOptions('user-1');

    // First call: query for existing options
    expect(mockSend).toHaveBeenCalledTimes(2);
    const queryInput = mockSend.mock.calls[0][0].input;
    expect(queryInput.TableName).toBe('test-saved-options');
    expect(queryInput.KeyConditionExpression).toBe('userId = :userId');
    expect(queryInput.ExpressionAttributeValues[':userId']).toBe('user-1');

    // Second call: PutCommand with default options
    const putInput = mockSend.mock.calls[1][0].input;
    expect(putInput.TableName).toBe('test-saved-options');
    expect(putInput.Item.userId).toBe('user-1');
    expect(putInput.Item.strategies).toEqual(DEFAULT_SAVED_OPTIONS.strategies);
    expect(putInput.Item.newsEvents).toEqual(DEFAULT_SAVED_OPTIONS.newsEvents);
    expect(putInput.Item.sessions).toEqual(DEFAULT_SAVED_OPTIONS.sessions);
    expect(putInput.Item.marketConditions).toEqual(DEFAULT_SAVED_OPTIONS.marketConditions);
    expect(putInput.Item.mistakes).toEqual(DEFAULT_SAVED_OPTIONS.mistakes);
    expect(putInput.Item.symbols).toEqual([]);
    expect(putInput.Item.lessons).toEqual([]);
    expect(putInput.Item.timeframes).toEqual([]);
    expect(putInput.Item.createdAt).toBeDefined();
    expect(putInput.Item.updatedAt).toBeDefined();
  });

  it('skips creation when user already has saved options (idempotent)', async () => {
    mockSend.mockResolvedValueOnce({
      Items: [{ userId: 'user-1', strategies: ['Breakout'] }],
    });

    await createDefaultSavedOptions('user-1');

    // Should query but NOT put
    expect(mockSend).toHaveBeenCalledTimes(1);
  });

  it('proceeds when Items is undefined', async () => {
    mockSend.mockResolvedValueOnce({});
    mockSend.mockResolvedValueOnce({});

    await createDefaultSavedOptions('user-1');

    // Items is undefined, so condition is falsy, proceeds to put
    expect(mockSend).toHaveBeenCalledTimes(2);
  });

  it('sets createdAt and updatedAt to the same timestamp', async () => {
    mockSend.mockResolvedValueOnce({ Items: [] });
    mockSend.mockResolvedValueOnce({});

    await createDefaultSavedOptions('user-1');

    const putInput = mockSend.mock.calls[1][0].input;
    expect(putInput.Item.createdAt).toBe(putInput.Item.updatedAt);
    // Verify it's a valid ISO date string
    expect(new Date(putInput.Item.createdAt).toISOString()).toBe(putInput.Item.createdAt);
  });
});

describe('DEFAULT_RULES', () => {
  it('contains expected number of default rules', () => {
    expect(DEFAULT_RULES).toHaveLength(6);
  });

  it('contains only non-empty strings', () => {
    for (const rule of DEFAULT_RULES) {
      expect(typeof rule).toBe('string');
      expect(rule.length).toBeGreaterThan(0);
    }
  });
});

describe('DEFAULT_SAVED_OPTIONS', () => {
  it('has all expected option categories', () => {
    expect(DEFAULT_SAVED_OPTIONS).toHaveProperty('strategies');
    expect(DEFAULT_SAVED_OPTIONS).toHaveProperty('newsEvents');
    expect(DEFAULT_SAVED_OPTIONS).toHaveProperty('sessions');
    expect(DEFAULT_SAVED_OPTIONS).toHaveProperty('marketConditions');
    expect(DEFAULT_SAVED_OPTIONS).toHaveProperty('mistakes');
    expect(DEFAULT_SAVED_OPTIONS).toHaveProperty('symbols');
    expect(DEFAULT_SAVED_OPTIONS).toHaveProperty('lessons');
    expect(DEFAULT_SAVED_OPTIONS).toHaveProperty('timeframes');
  });

  it('has populated arrays for default categories', () => {
    expect(DEFAULT_SAVED_OPTIONS.strategies.length).toBeGreaterThan(0);
    expect(DEFAULT_SAVED_OPTIONS.newsEvents.length).toBeGreaterThan(0);
    expect(DEFAULT_SAVED_OPTIONS.sessions.length).toBeGreaterThan(0);
    expect(DEFAULT_SAVED_OPTIONS.marketConditions.length).toBeGreaterThan(0);
    expect(DEFAULT_SAVED_OPTIONS.mistakes.length).toBeGreaterThan(0);
  });

  it('has empty arrays for user-specific categories', () => {
    expect(DEFAULT_SAVED_OPTIONS.symbols).toEqual([]);
    expect(DEFAULT_SAVED_OPTIONS.lessons).toEqual([]);
    expect(DEFAULT_SAVED_OPTIONS.timeframes).toEqual([]);
  });
});
