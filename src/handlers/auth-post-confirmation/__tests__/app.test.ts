import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBDocumentClient, PutCommand } from '@aws-sdk/lib-dynamodb';

vi.stubEnv('SUBSCRIPTIONS_TABLE', 'test-subscriptions');

vi.mock('../../../shared/user-initialization', () => ({
  createDefaultRules: vi.fn().mockResolvedValue(undefined),
  createDefaultSavedOptions: vi.fn().mockResolvedValue(undefined),
}));

const ddbMock = mockClient(DynamoDBDocumentClient);

const { handler } = await import('../app.ts');

import { createDefaultRules, createDefaultSavedOptions } from '../../../shared/user-initialization';

beforeEach(() => {
  ddbMock.reset();
  ddbMock.on(PutCommand).resolves({});
  vi.mocked(createDefaultRules).mockClear();
  vi.mocked(createDefaultSavedOptions).mockClear();
});

describe('auth-post-confirmation handler', () => {
  const makeEvent = (triggerSource: string, sub = 'user-123') => ({
    triggerSource,
    request: {
      userAttributes: {
        sub,
      },
    },
  });

  it('creates default rules, saved options, and trial subscription on PostConfirmation_ConfirmSignUp', async () => {
    const event = makeEvent('PostConfirmation_ConfirmSignUp');

    const result = await handler(event);

    expect(result).toEqual(event);
    expect(createDefaultRules).toHaveBeenCalledWith('user-123');
    expect(createDefaultSavedOptions).toHaveBeenCalledWith('user-123');

    const putCalls = ddbMock.commandCalls(PutCommand);
    expect(putCalls).toHaveLength(1);
    expect(putCalls[0].args[0].input.TableName).toBe('test-subscriptions');
    expect(putCalls[0].args[0].input.Item.userId).toBe('user-123');
  });

  it('sets trialEnd to 30 days in the future', async () => {
    const event = makeEvent('PostConfirmation_ConfirmSignUp');

    await handler(event);

    const putCalls = ddbMock.commandCalls(PutCommand);
    expect(putCalls).toHaveLength(1);
    const trialEnd = new Date(putCalls[0].args[0].input.Item.trialEnd);
    const now = new Date();
    const diffDays = (trialEnd.getTime() - now.getTime()) / (1000 * 60 * 60 * 24);
    expect(diffDays).toBeGreaterThan(29);
    expect(diffDays).toBeLessThan(31);
  });

  it('sets status to trial in the subscription record', async () => {
    const event = makeEvent('PostConfirmation_ConfirmSignUp');

    await handler(event);

    const putCalls = ddbMock.commandCalls(PutCommand);
    expect(putCalls).toHaveLength(1);
    expect(putCalls[0].args[0].input.Item.status).toBe('trial');
  });

  it('uses ConditionExpression to prevent overwriting existing subscription', async () => {
    const event = makeEvent('PostConfirmation_ConfirmSignUp');

    await handler(event);

    const putCalls = ddbMock.commandCalls(PutCommand);
    expect(putCalls).toHaveLength(1);
    expect(putCalls[0].args[0].input.ConditionExpression).toBe('attribute_not_exists(userId)');
  });

  it('returns the event as required by Cognito triggers', async () => {
    const event = makeEvent('PostConfirmation_ConfirmSignUp');

    const result = await handler(event);

    expect(result).toEqual(event);
  });

  it('handles DynamoDB errors gracefully and still returns event', async () => {
    ddbMock.on(PutCommand).rejects(new Error('DynamoDB error'));

    const event = makeEvent('PostConfirmation_ConfirmSignUp', 'user-789');

    const result = await handler(event);

    expect(result).toEqual(event);
  });

  it('skips creation for non-ConfirmSignUp triggers', async () => {
    const event = makeEvent('PostConfirmation_ConfirmForgotPassword', 'user-456');

    const result = await handler(event);

    expect(result).toEqual(event);
    expect(createDefaultRules).not.toHaveBeenCalled();
    expect(createDefaultSavedOptions).not.toHaveBeenCalled();
    const putCalls = ddbMock.commandCalls(PutCommand);
    expect(putCalls).toHaveLength(0);
  });

  it('calls createDefaultRules and createDefaultSavedOptions', async () => {
    const event = makeEvent('PostConfirmation_ConfirmSignUp', 'user-abc');

    await handler(event);

    expect(createDefaultRules).toHaveBeenCalledOnce();
    expect(createDefaultRules).toHaveBeenCalledWith('user-abc');
    expect(createDefaultSavedOptions).toHaveBeenCalledOnce();
    expect(createDefaultSavedOptions).toHaveBeenCalledWith('user-abc');
  });
});
