import { DynamoDBDocumentClient, GetCommand, ScanCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { mockClient } from 'aws-sdk-client-mock';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.stubEnv('SUBSCRIPTIONS_TABLE', 'subs');
vi.stubEnv('USER_PREFERENCES_TABLE', 'prefs');
vi.stubEnv('APP_URL', 'https://tradequt.com');

const sendEmail = vi.fn();
const getUserEmail = vi.fn();
vi.mock('../../../shared/email', async (orig) => ({
  ...(await orig<typeof import('../../../shared/email')>()),
  sendEmail: (...a: any[]) => sendEmail(...a),
  getUserEmail: (...a: any[]) => getUserEmail(...a),
}));

const ddb = mockClient(DynamoDBDocumentClient);
const { runLifecycleEmails, runWeeklyReports } = await import('../app');

const NOW = new Date('2026-11-11T04:00:00Z');
const inDays = (d: number) => new Date(NOW.getTime() + d * 86400000).toISOString();

beforeEach(() => {
  ddb.reset();
  sendEmail.mockReset().mockResolvedValue(undefined);
  getUserEmail.mockReset().mockImplementation(async (id: string) => `${id}@example.com`);
  ddb.on(UpdateCommand).resolves({});
});

describe('runLifecycleEmails', () => {
  it('mails trial users 3 days before the end and once the trial has ended — and nobody else', async () => {
    ddb.on(ScanCommand).resolves({ Items: [
      { userId: 'ending', status: 'trial', trialEnd: inDays(2.5) },
      { userId: 'ended', status: 'trial', trialEnd: inDays(-0.5) },
      { userId: 'later', status: 'trial', trialEnd: inDays(8) },
      { userId: 'longago', status: 'trial', trialEnd: inDays(-10) },
      { userId: 'paying', status: 'active' },
      { userId: 'cancelled', status: 'cancelled', trialEnd: inDays(2.5) },
    ] });
    const result = await runLifecycleEmails(NOW);
    expect(result).toEqual({ trialEnding: 1, trialEnded: 1, failed: 0 });
    const sent = sendEmail.mock.calls.map((c) => [c[0].to, c[0].subject]);
    expect(sent).toEqual([
      ['ending@example.com', 'Your TradeQut Pro trial ends in 3 days'],
      ['ended@example.com', 'Your TradeQut Pro trial has ended'],
    ]);
  });

  it('the ended mail states what changed and never uses "keep access" wording', async () => {
    ddb.on(ScanCommand).resolves({ Items: [{ userId: 'u', status: 'trial', trialEnd: inDays(-0.1) }] });
    await runLifecycleEmails(NOW);
    const mail = sendEmail.mock.calls[0][0];
    expect(mail.text).toContain('Free plan');
    expect(mail.text).toContain('2 trading accounts');
    expect(mail.text.toLowerCase()).not.toContain('keep access');
  });

  it('marks each mail so a rerun does not send it twice', async () => {
    ddb.on(ScanCommand).resolves({ Items: [{ userId: 'u', status: 'trial', trialEnd: inDays(2.5) }] });
    ddb.on(UpdateCommand).rejects(Object.assign(new Error('c'), { name: 'ConditionalCheckFailedException' }));
    expect(await runLifecycleEmails(NOW)).toEqual({ trialEnding: 0, trialEnded: 0, failed: 0 });
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it('counts a failed send and carries on with the next user', async () => {
    ddb.on(ScanCommand).resolves({ Items: [
      { userId: 'a', status: 'trial', trialEnd: inDays(2.5) },
      { userId: 'b', status: 'trial', trialEnd: inDays(2.5) },
    ] });
    sendEmail.mockRejectedValueOnce(new Error('SES sandbox')).mockResolvedValue(undefined);
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(await runLifecycleEmails(NOW)).toEqual({ trialEnding: 1, trialEnded: 0, failed: 1 });
    spy.mockRestore();
  });

  it('skips users who no longer exist in Cognito', async () => {
    ddb.on(ScanCommand).resolves({ Items: [{ userId: 'gone', status: 'trial', trialEnd: inDays(2.5) }] });
    getUserEmail.mockResolvedValue(null);
    expect((await runLifecycleEmails(NOW)).trialEnding).toBe(0);
  });
});

describe('runWeeklyReports', () => {
  const generate = vi.fn();
  beforeEach(() => {
    generate.mockReset().mockResolvedValue({ ok: true, cached: false, summary: 'Great week.' });
    ddb.on(GetCommand).resolves({});
    ddb.on(ScanCommand).resolves({ Items: [
      { userId: 'pro', status: 'active' },
      { userId: 'trial', status: 'trial', trialEnd: inDays(5) },
      { userId: 'free', status: 'cancelled' },
      { userId: 'optout', status: 'active' },
    ] });
    ddb.on(GetCommand).callsFake((i) => (i.Key.userId === 'optout' ? { Item: { notifications: { weeklyReport: false } } } : {}));
  });

  it('generates the last 7 days for Pro and trial users with the report switched on, then mails them', async () => {
    const result = await runWeeklyReports({ generate }, NOW);
    expect(result).toEqual({ generated: 2, skipped: 1, failed: 0 }); // the opted-out user is the skipped one
    expect(generate.mock.calls.map((c) => c[0])).toEqual(['pro', 'trial']);
    expect(generate.mock.calls[0][2]).toEqual({ from: '2026-11-04', to: '2026-11-10' });
    expect(sendEmail.mock.calls[0][0]).toMatchObject({ to: 'pro@example.com', subject: 'Your TradeQut weekly report is ready' });
  });

  it('honours the notifications preference and carries the way to switch the mail off', async () => {
    const result = await runWeeklyReports({ generate }, NOW);
    expect(generate.mock.calls.map((c) => c[0])).not.toContain('optout');
    expect(result.generated).toBe(2);
    expect(sendEmail.mock.calls[0][0].text).toContain('/app/settings#notifications');
  });

  it('generates for several users at once but never more than 8 in flight, so a large run fits the timeout (BE-023)', async () => {
    ddb.on(ScanCommand).resolves({ Items: Array.from({ length: 30 }, (_, i) => ({ userId: `u${i}`, status: 'active' })) });
    ddb.on(GetCommand).resolves({});
    let inFlight = 0;
    let peak = 0;
    generate.mockImplementation(async () => {
      peak = Math.max(peak, ++inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      return { ok: true, cached: false, summary: 's' };
    });

    const result = await runWeeklyReports({ generate }, NOW);

    expect(result).toEqual({ generated: 30, skipped: 0, failed: 0 });
    expect(generate).toHaveBeenCalledTimes(30);
    expect(peak).toBeGreaterThan(1);
    expect(peak).toBeLessThanOrEqual(8);
  });

  it('one failing user does not stop the others', async () => {
    generate.mockRejectedValueOnce(new Error('Gemini down')).mockResolvedValue({ ok: true, cached: false, summary: 's' });
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const result = await runWeeklyReports({ generate }, NOW);
    expect(result).toEqual({ generated: 1, skipped: 1, failed: 1 });
    spy.mockRestore();
  });

  it('sends nothing when the insight was cached or could not be generated', async () => {
    generate.mockResolvedValueOnce({ ok: true, cached: true }).mockResolvedValueOnce({ ok: false });
    const result = await runWeeklyReports({ generate }, NOW);
    expect(result).toMatchObject({ generated: 0, skipped: 3 }); // cached + not generated + opted out
    expect(sendEmail).not.toHaveBeenCalled();
  });
});
