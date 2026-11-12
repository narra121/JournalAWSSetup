import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.stubEnv('SUBSCRIPTIONS_TABLE', 'subs');
vi.stubEnv('USAGE_TABLE', 'usage');

const calls: string[] = [];
vi.mock('../../handlers/auth-pre-signup/app', () => ({ handler: async (e: any) => (calls.push('pre'), e) }));
vi.mock('../../handlers/auth-post-confirmation/app', () => ({ handler: async (e: any) => (calls.push('post'), e) }));
vi.mock('../../handlers/update-stats/app', () => ({ handler: async () => (calls.push('stats'), { batchItemFailures: [] }) }));
vi.mock('../../handlers/preference-changes/app', () => ({ handlePreferenceChanges: async () => (calls.push('prefs'), { batchItemFailures: [] }) }));
vi.mock('../../handlers/rebuild-stats-job/app', () => ({ handler: async () => (calls.push('rebuild'), { rebuiltUsers: 0 }) }));
vi.mock('../../handlers/lifecycle-emails/app', () => ({
  runLifecycleEmails: async () => (calls.push('lifecycle'), { trialEnding: 0 }),
  runWeeklyReports: async () => (calls.push('weekly'), { generated: 0 }),
  defaultWeeklyDeps: async () => ({ generate: async () => ({ ok: false }) }),
}));

const { handler } = await import('../events');

beforeEach(() => {
  calls.length = 0;
});

describe('Event Function dispatcher', () => {
  it('routes the Cognito triggers', async () => {
    await handler({ triggerSource: 'PreSignUp_SignUp' });
    await handler({ triggerSource: 'PreSignUp_ExternalProvider' });
    await handler({ triggerSource: 'PostConfirmation_ConfirmSignUp' });
    expect(calls).toEqual(['pre', 'pre', 'post']);
  });

  it('routes DynamoDB stream batches and returns batchItemFailures', async () => {
    const res = await handler({ Records: [{ eventSource: 'aws:dynamodb' }] });
    expect(res).toEqual({ batchItemFailures: [] });
    expect(calls).toEqual(['stats']);
  });

  it('routes UserPreferences stream batches to the time-zone rebuild, Trades batches to the stats handler', async () => {
    await handler({ Records: [{ eventSource: 'aws:dynamodb', eventSourceARN: 'arn:aws:dynamodb:us-east-1:1:table/UserPreferences-tradequt-dev/stream/x' }] });
    await handler({ Records: [{ eventSource: 'aws:dynamodb', eventSourceARN: 'arn:aws:dynamodb:us-east-1:1:table/Trades-tradequt-dev-v1/stream/x' }] });
    expect(calls).toEqual(['prefs', 'stats']);
  });

  it('routes the scheduled rebuild job', async () => {
    await handler({ job: 'rebuild-stats' });
    expect(calls).toEqual(['rebuild']);
  });

  it('routes the daily e-mail job and the weekly insights job', async () => {
    await handler({ job: 'lifecycle-emails' });
    await handler({ job: 'weekly-insights' });
    expect(calls).toEqual(['lifecycle', 'weekly']);
  });

  it('rejects unknown events', async () => {
    await expect(handler({ hello: 'world' })).rejects.toThrow('Unsupported event');
  });
});
