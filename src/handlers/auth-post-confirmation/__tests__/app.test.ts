import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBDocumentClient, PutCommand } from '@aws-sdk/lib-dynamodb';

vi.stubEnv('SUBSCRIPTIONS_TABLE', 'test-subscriptions');

vi.mock('../../../shared/user-initialization', () => ({
  createDefaultRules: vi.fn().mockResolvedValue(undefined),
  createDefaultSavedOptions: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../../shared/email', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../shared/email')>()),
  sendEmail: vi.fn().mockResolvedValue(undefined),
}));

const ddbMock = mockClient(DynamoDBDocumentClient);

const { handler } = await import('../app.ts');

import { createDefaultRules, createDefaultSavedOptions } from '../../../shared/user-initialization';
import { sendEmail } from '../../../shared/email';

beforeEach(() => {
  ddbMock.reset();
  ddbMock.on(PutCommand).resolves({});
  vi.mocked(createDefaultRules).mockClear();
  vi.mocked(createDefaultSavedOptions).mockClear();
  vi.mocked(sendEmail).mockReset().mockResolvedValue(undefined);
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

  describe('welcome mail', () => {
    const withEmail = (triggerSource: string, sub: string) => {
      const event = makeEvent(triggerSource, sub);
      return { ...event, request: { userAttributes: { ...event.request.userAttributes, email: 'new@example.com' } } };
    };

    it('goes once to the confirmed address when the trial row is new, with the trial end date', async () => {
      await handler(withEmail('PostConfirmation_ConfirmSignUp', 'user-w1'));

      expect(sendEmail).toHaveBeenCalledOnce();
      const mail = vi.mocked(sendEmail).mock.calls[0][0];
      const trialEnd = ddbMock.commandCalls(PutCommand)[0].args[0].input.Item!.trialEnd as string;
      expect(mail.to).toBe('new@example.com');
      expect(mail.subject).toBe('Your TradeQut journal is ready');
      expect(mail.text).toContain(`until ${trialEnd.slice(0, 10)}`);
    });

    it('is not sent again when the trial row already exists (a repeated confirmation)', async () => {
      ddbMock.on(PutCommand).rejects(Object.assign(new Error('The conditional request failed'), { name: 'ConditionalCheckFailedException' }));

      await handler(withEmail('PostConfirmation_ConfirmSignUp', 'user-w2'));

      expect(sendEmail).not.toHaveBeenCalled();
    });

    it('is not sent for other triggers or when Cognito gives no address', async () => {
      await handler(withEmail('PostConfirmation_ConfirmForgotPassword', 'user-w3'));
      await handler(makeEvent('PostConfirmation_ConfirmSignUp', 'user-w4'));

      expect(sendEmail).not.toHaveBeenCalled();
    });

    it('a failed send is logged and the confirmation still succeeds', async () => {
      vi.mocked(sendEmail).mockRejectedValueOnce(new Error('SES down'));
      const errorLog = vi.spyOn(console, 'error').mockImplementation(() => undefined);

      const event = withEmail('PostConfirmation_ConfirmSignUp', 'user-w5');
      await expect(handler(event)).resolves.toEqual(event);
      expect(errorLog).toHaveBeenCalledWith('welcome mail failed', { userId: 'user-w5', error: 'SES down' });
      errorLog.mockRestore();
    });

    it('a send that does not answer within 2 s is given up, so the trigger stays inside the 5 s Cognito allows', async () => {
      vi.useFakeTimers();
      vi.mocked(sendEmail).mockReturnValueOnce(new Promise(() => undefined));
      const errorLog = vi.spyOn(console, 'error').mockImplementation(() => undefined);

      const event = withEmail('PostConfirmation_ConfirmSignUp', 'user-w6');
      const run = handler(event);
      await vi.advanceTimersByTimeAsync(2000);
      await expect(run).resolves.toEqual(event);
      expect(errorLog).toHaveBeenCalledWith('welcome mail failed', { userId: 'user-w6', error: 'no answer in 2000 ms' });
      errorLog.mockRestore();
      vi.useRealTimers();
    });
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
