import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBDocumentClient, BatchWriteCommand, PutCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';

vi.stubEnv('RULES_TABLE', 'test-rules');
vi.stubEnv('SAVED_OPTIONS_TABLE', 'test-saved-options');

const ddbMock = mockClient(DynamoDBDocumentClient);

const { handler } = await import('../app.ts');

beforeEach(() => {
  ddbMock.reset();
  ddbMock.on(QueryCommand).resolves({ Items: [] });
  ddbMock.on(BatchWriteCommand).resolves({ UnprocessedItems: {} });
  ddbMock.on(PutCommand).resolves({});
});

describe('auth-post-confirmation handler', () => {
  it('creates default rules and options for PostConfirmation_ConfirmSignUp', async () => {
    const event = {
      triggerSource: 'PostConfirmation_ConfirmSignUp',
      request: { userAttributes: { sub: 'user-123' } },
      response: {},
    };

    const result = await handler(event);

    expect(result).toEqual(event);
    // Should have created rules via batch write
    const batchCalls = ddbMock.commandCalls(BatchWriteCommand);
    expect(batchCalls).toHaveLength(1);
    const items = batchCalls[0].args[0].input.RequestItems?.['test-rules'];
    expect(items).toHaveLength(6);
    // Should have created saved options via put
    const putCalls = ddbMock.commandCalls(PutCommand);
    expect(putCalls).toHaveLength(1);
    expect(putCalls[0].args[0].input.Item?.userId).toBe('user-123');
  });

  it('does not create defaults for PostConfirmation_ForgotPassword', async () => {
    const event = {
      triggerSource: 'PostConfirmation_ForgotPassword',
      request: { userAttributes: { sub: 'user-456' } },
      response: {},
    };

    const result = await handler(event);

    expect(result).toEqual(event);
    const batchCalls = ddbMock.commandCalls(BatchWriteCommand);
    expect(batchCalls).toHaveLength(0);
    const putCalls = ddbMock.commandCalls(PutCommand);
    expect(putCalls).toHaveLength(0);
  });

  it('returns event even if default creation fails', async () => {
    ddbMock.on(QueryCommand).resolves({ Items: [] });
    ddbMock.on(BatchWriteCommand).rejects(new Error('DynamoDB error'));

    const event = {
      triggerSource: 'PostConfirmation_ConfirmSignUp',
      request: { userAttributes: { sub: 'user-789' } },
      response: {},
    };

    const result = await handler(event);

    // Should still return event even on failure
    expect(result).toEqual(event);
  });

  it('skips rules creation if user already has rules', async () => {
    ddbMock.on(QueryCommand, { TableName: 'test-rules' }).resolves({
      Items: [{ userId: 'user-existing', ruleId: 'r1' }],
    });
    ddbMock.on(QueryCommand, { TableName: 'test-saved-options' }).resolves({ Items: [] });

    const event = {
      triggerSource: 'PostConfirmation_ConfirmSignUp',
      request: { userAttributes: { sub: 'user-existing' } },
      response: {},
    };

    await handler(event);

    const batchCalls = ddbMock.commandCalls(BatchWriteCommand);
    expect(batchCalls).toHaveLength(0);
    // Saved options should still be created
    const putCalls = ddbMock.commandCalls(PutCommand);
    expect(putCalls).toHaveLength(1);
  });
});
