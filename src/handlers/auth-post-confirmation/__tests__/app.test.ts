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
    expect(putCalls[0].args[0].input.Item!.userId).toBe('user-123');
  });

  it('starts the free trial on the trial and Pro plans (plansVersion 2, status trial)', async () => {
    await handler(makeEvent('PostConfirmation_ConfirmSignUp'));
    const item = ddbMock.commandCalls(PutCommand)[0].args[0].input.Item!;
    expect(item).toMatchObject({ status: 'trial', plansVersion: 2 });
    expect(ddbMock.commandCalls(PutCommand)[0].args[0].input.ConditionExpression).toBe('attribute_not_exists(userId)');
  });

  it('sets trialEnd to 14 days in the future', async () => {
    const event = makeEvent('PostConfirmation_ConfirmSignUp');

    await handler(event);

    const putCalls = ddbMock.commandCalls(PutCommand);
    expect(putCalls).toHaveLength(1);
    const trialEnd = new Date(putCalls[0].args[0].input.Item!.trialEnd);
    const now = new Date();
    const diffDays = (trialEnd.getTime() - now.getTime()) / (1000 * 60 * 60 * 24);
    expect(diffDays).toBeGreaterThan(13);
    expect(diffDays).toBeLessThan(15);
  });

  it('sets status to trial in the subscription record', async () => {
    const event = makeEvent('PostConfirmation_ConfirmSignUp');

    await handler(event);

    const putCalls = ddbMock.commandCalls(PutCommand);
    expect(putCalls).toHaveLength(1);
    expect(putCalls[0].args[0].input.Item!.status).toBe('trial');
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

  it('fails the confirmation when the trial row cannot be written, so Cognito reports an error and the user retries', async () => {
    ddbMock.on(PutCommand).rejects(new Error('DynamoDB error'));

    await expect(handler(makeEvent('PostConfirmation_ConfirmSignUp', 'user-789'))).rejects.toThrow('DynamoDB error');
    expect(createDefaultRules).toHaveBeenCalledWith('user-789');
  });

  it('treats an existing trial row as success (a repeated confirmation) and does not log it as an error', async () => {
    const exists = Object.assign(new Error('The conditional request failed'), { name: 'ConditionalCheckFailedException' });
    ddbMock.on(PutCommand).rejects(exists);
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const event = makeEvent('PostConfirmation_ConfirmSignUp', 'user-790');
    await expect(handler(event)).resolves.toEqual(event);
    expect(errorLog).not.toHaveBeenCalled();
    errorLog.mockRestore();
  });

  it('still returns the event when only the default rules or saved options fail', async () => {
    vi.mocked(createDefaultRules).mockRejectedValueOnce(new Error('rules failed'));
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const event = makeEvent('PostConfirmation_ConfirmSignUp', 'user-791');
    await expect(handler(event)).resolves.toEqual(event);
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
