import { DynamoDBDocumentClient, GetCommand, QueryCommand, ScanCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { mockClient } from 'aws-sdk-client-mock';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.stubEnv('SUBSCRIPTIONS_TABLE', 'subs');
vi.stubEnv('USER_PREFERENCES_TABLE', 'prefs');
vi.stubEnv('TRADES_TABLE', 'trades');
vi.stubEnv('APP_URL', 'https://tradequt.com');

const sendEmail = vi.fn();
const getUserEmail = vi.fn();
vi.mock('../../../shared/email', async (orig) => ({
  ...(await orig<typeof import('../../../shared/email')>()),
  sendEmail: (...a: any[]) => sendEmail(...a),
  getUserEmail: (...a: any[]) => getUserEmail(...a),
}));

const ddb = mockClient(DynamoDBDocumentClient);
const { defaultWeeklyDeps, runLifecycleEmails, runWeeklyReports } = await import('../app');

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
    expect(result).toEqual({ trialEnding: 1, trialEnded: 1, gettingStarted: 0, failed: 0 });
    const sent = sendEmail.mock.calls.map((c) => [c[0].to, c[0].subject]);
    expect(sent).toEqual([
      ['ending@example.com', 'Your TradeQut free trial ends in 3 days'],
      ['ended@example.com', 'Your TradeQut free trial has ended'],
    ]);
  });

  it('the ended mail states what changed and never uses "keep access" wording', async () => {
    ddb.on(ScanCommand).resolves({ Items: [{ userId: 'u', status: 'trial', trialEnd: inDays(-0.1) }] });
    await runLifecycleEmails(NOW);
    const mail = sendEmail.mock.calls[0][0];
    expect(mail.text).toContain('read-only');
    expect(mail.text).toContain('view and export');
    expect(mail.text.toLowerCase()).not.toContain('keep access');
  });

  it('marks each mail so a rerun does not send it twice', async () => {
    ddb.on(ScanCommand).resolves({ Items: [{ userId: 'u', status: 'trial', trialEnd: inDays(2.5) }] });
    ddb.on(UpdateCommand).rejects(Object.assign(new Error('c'), { name: 'ConditionalCheckFailedException' }));
    expect(await runLifecycleEmails(NOW)).toEqual({ trialEnding: 0, trialEnded: 0, gettingStarted: 0, failed: 0 });
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it('counts a failed send and carries on with the next user', async () => {
    ddb.on(ScanCommand).resolves({ Items: [
      { userId: 'a', status: 'trial', trialEnd: inDays(2.5) },
      { userId: 'b', status: 'trial', trialEnd: inDays(2.5) },
    ] });
    sendEmail.mockRejectedValueOnce(new Error('SES sandbox')).mockResolvedValue(undefined);
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(await runLifecycleEmails(NOW)).toEqual({ trialEnding: 1, trialEnded: 0, gettingStarted: 0, failed: 1 });
    spy.mockRestore();
  });

  it('skips users who no longer exist in Cognito', async () => {
    ddb.on(ScanCommand).resolves({ Items: [{ userId: 'gone', status: 'trial', trialEnd: inDays(2.5) }] });
    getUserEmail.mockResolvedValue(null);
    expect((await runLifecycleEmails(NOW)).trialEnding).toBe(0);
  });
});

describe('runLifecycleEmails: getting-started mails of the first week', () => {
  const trialUser = (userId: string, daysSinceSignUp: number, extra: Record<string, unknown> = {}) => ({
    userId,
    status: 'trial',
    trialStarted: inDays(-daysSinceSignUp),
    trialEnd: inDays(14 - daysSinceSignUp),
    ...extra,
  });
  const run = async (items: Record<string, unknown>[], traded: Record<string, boolean> = {}) => {
    ddb.on(ScanCommand).resolves({ Items: items });
    ddb.on(GetCommand).resolves({ Item: { notifications: { tradeReminders: true } } });
    ddb.on(QueryCommand).callsFake((input) => ({ Count: traded[input.ExpressionAttributeValues[':u']] ? 1 : 0 }));
    const result = await runLifecycleEmails(NOW);
    return { result, sent: sendEmail.mock.calls.map((c) => [c[0].to, c[0].subject]) };
  };

  it('day 1 and day 3 tell a user without trades how to get them in; day 7 says nothing to an empty journal', async () => {
    const { result, sent } = await run([trialUser('d1', 1.5), trialUser('d3', 3.5), trialUser('d7', 7.5)]);
    expect(sent).toEqual([
      ['d1@example.com', 'Get your first trades into TradeQut'],
      ['d3@example.com', 'Three ways to get trades into TradeQut'],
    ]);
    expect(result).toEqual({ trialEnding: 0, trialEnded: 0, gettingStarted: 2, failed: 0 });
  });

  it('a user who has trades is not told to import: nothing on day 1, tagging on day 3, the review on day 7', async () => {
    const { sent } = await run([trialUser('d1', 1.5), trialUser('d3', 3.5), trialUser('d7', 7.5)], { d1: true, d3: true, d7: true });
    expect(sent).toEqual([
      ['d3@example.com', 'See what each mistake costs you'],
      ['d7@example.com', 'Review your first week in TradeQut'],
    ]);
  });

  it('sends nothing outside the three one-day windows', async () => {
    const { sent } = await run([0.5, 2.5, 4.5, 6.9, 8.1, 13].map((d, i) => trialUser(`u${i}`, d)));
    expect(sent).toEqual([]);
    expect(ddb.commandCalls(GetCommand)).toHaveLength(0);
  });

  it('a row without trialStarted (an older user whose trial was granted again) gets none', async () => {
    const { sent } = await run([{ userId: 'old', status: 'trial', trialGrantedAt: inDays(-1.5), trialEnd: inDays(12.5) }]);
    expect(sent).toEqual([]);
  });

  it('paying and cancelled users get none', async () => {
    const { sent } = await run([trialUser('paid', 1.5, { status: 'active' }), trialUser('gone', 3.5, { status: 'cancelled' })]);
    expect(sent).toEqual([]);
  });

  it('a user who switched the mails off gets none, and nothing is marked', async () => {
    ddb.on(ScanCommand).resolves({ Items: [trialUser('off', 1.5)] });
    ddb.on(GetCommand).resolves({ Item: { notifications: { tradeReminders: false } } });
    ddb.on(QueryCommand).resolves({ Count: 0 });
    expect((await runLifecycleEmails(NOW)).gettingStarted).toBe(0);
    expect(sendEmail).not.toHaveBeenCalled();
    expect(ddb.commandCalls(UpdateCommand)).toHaveLength(0);
  });

  it('a user with no preferences row yet gets the mails (the switch is on by default)', async () => {
    ddb.on(ScanCommand).resolves({ Items: [trialUser('new', 1.5)] });
    ddb.on(GetCommand).resolves({});
    ddb.on(QueryCommand).resolves({ Count: 0 });
    expect((await runLifecycleEmails(NOW)).gettingStarted).toBe(1);
  });

  it('marks each mail with the sign-up time so a rerun the same day does not send it twice', async () => {
    const user = trialUser('once', 3.5);
    await run([user]);
    const mark = ddb.commandCalls(UpdateCommand)[0].args[0].input;
    expect(mark.ExpressionAttributeNames).toEqual({ '#m': 'gettingStartedDay3For' });
    expect(mark.ExpressionAttributeValues).toEqual({ ':v': user.trialStarted });

    sendEmail.mockClear();
    ddb.on(UpdateCommand).rejects(Object.assign(new Error('c'), { name: 'ConditionalCheckFailedException' }));
    expect((await runLifecycleEmails(NOW)).gettingStarted).toBe(0);
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it('counts only trades that are not deleted, also when the first page holds deleted ones only', async () => {
    ddb.on(ScanCommand).resolves({ Items: [trialUser('paged', 1.5)] });
    ddb.on(GetCommand).resolves({});
    ddb.on(QueryCommand).resolvesOnce({ Count: 0, LastEvaluatedKey: { userId: 'paged', tradeId: 't1' } }).resolves({ Count: 1 });
    expect((await runLifecycleEmails(NOW)).gettingStarted).toBe(0);
    const queries = ddb.commandCalls(QueryCommand);
    expect(queries).toHaveLength(2);
    expect(queries[0].args[0].input).toMatchObject({ TableName: 'trades', FilterExpression: 'attribute_not_exists(deletedAt)', Select: 'COUNT' });
    expect(queries[0].args[0].input.Limit).toBeUndefined();
    expect(queries[1].args[0].input.ExclusiveStartKey).toEqual({ userId: 'paged', tradeId: 't1' });
  });

  it('every getting-started mail carries the switch-off link in both parts and no upgrade pitch', async () => {
    await run([trialUser('a', 1.5), trialUser('b', 3.5), trialUser('c', 3.5), trialUser('d', 7.5)], { c: true, d: true });
    expect(sendEmail).toHaveBeenCalledTimes(4);
    for (const [mail] of sendEmail.mock.calls) {
      expect(mail.text).toContain('https://tradequt.com/app/settings/notifications');
      expect(mail.html).toContain('<a href="https://tradequt.com/app/settings/notifications">Settings → Notifications</a>');
      expect(mail.subject + mail.text + mail.html).not.toMatch(/\bPro\b|upgrade|\$\d|₹|\bbest\b|#1\b|free forever|auto.?sync|mobile app|guarantee/i);
    }
  });

  it('a failed getting-started send is counted and the next user still gets theirs', async () => {
    sendEmail.mockRejectedValueOnce(new Error('SES down')).mockResolvedValue(undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { result, sent } = await run([trialUser('a', 1.5), trialUser('b', 1.5)]);
    expect(result).toMatchObject({ gettingStarted: 1, failed: 1 });
    expect(sent).toHaveLength(2);
  });
});

describe('runWeeklyReports', () => {
  const generate = vi.fn();
  const plan = vi.fn();
  const deps = () => ({ plan, generate });
  beforeEach(() => {
    generate.mockReset().mockResolvedValue({ ok: true, cached: false, summary: 'Great week.' });
    plan.mockReset().mockResolvedValue({ from: '2026-11-04', to: '2026-11-10', currencies: ['INR'] });
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
    const result = await runWeeklyReports(deps(), NOW);
    expect(result).toEqual({ generated: 2, skipped: 1, failed: 0 }); // the opted-out user is the skipped one
    expect(generate.mock.calls.map((c) => c[0])).toEqual(['pro', 'trial']);
    expect(plan.mock.calls.map((c) => [c[0], c[1]])).toEqual([['pro', NOW], ['trial', NOW]]);
    expect(generate.mock.calls[0][2]).toEqual({ from: '2026-11-04', to: '2026-11-10', currency: 'INR' });
    expect(sendEmail.mock.calls[0][0]).toMatchObject({ to: 'pro@example.com', subject: 'Your TradeQut weekly report is ready' });
  });

  it('one report and one mail per currency the user traded; a user with no currency of 5+ trades gets none', async () => {
    plan.mockImplementation(async (userId: string) => ({ from: '2026-11-04', to: '2026-11-10', currencies: userId === 'pro' ? ['INR', 'USD'] : [] }));
    generate.mockImplementation(async (_u: string, _e: unknown, input: { currency: string }) => ({ ok: true, cached: false, summary: `${input.currency} week.` }));
    const result = await runWeeklyReports(deps(), NOW);
    expect(generate.mock.calls.map((c) => [c[0], c[2].currency])).toEqual([['pro', 'INR'], ['pro', 'USD']]);
    expect(result).toEqual({ generated: 2, skipped: 1, failed: 0 });
    expect(sendEmail.mock.calls.map((c) => c[0].to)).toEqual(['pro@example.com', 'pro@example.com']);
    expect(sendEmail.mock.calls.map((c) => c[0].text.includes('INR week.') ? 'INR' : c[0].text.includes('USD week.') ? 'USD' : '?')).toEqual(['INR', 'USD']);
  });

  it('honours the notifications preference and carries the way to switch the mail off', async () => {
    const result = await runWeeklyReports(deps(), NOW);
    expect(generate.mock.calls.map((c) => c[0])).not.toContain('optout');
    expect(plan.mock.calls.map((c) => c[0])).not.toContain('optout');
    expect(result.generated).toBe(2);
    expect(sendEmail.mock.calls[0][0].text).toContain('/app/settings/notifications');
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

    const result = await runWeeklyReports(deps(), NOW);

    expect(result).toEqual({ generated: 30, skipped: 0, failed: 0 });
    expect(generate).toHaveBeenCalledTimes(30);
    expect(peak).toBeGreaterThan(1);
    expect(peak).toBeLessThanOrEqual(8);
  });

  it('one failing user does not stop the others', async () => {
    generate.mockRejectedValueOnce(new Error('Gemini down')).mockResolvedValue({ ok: true, cached: false, summary: 's' });
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const result = await runWeeklyReports(deps(), NOW);
    expect(result).toEqual({ generated: 1, skipped: 1, failed: 1 });
    spy.mockRestore();
  });

  it('a failing currency does not stop the same user’s other currency', async () => {
    plan.mockImplementation(async (userId: string) => ({ from: '2026-11-04', to: '2026-11-10', currencies: userId === 'pro' ? ['INR', 'USD'] : [] }));
    generate.mockRejectedValueOnce(new Error('Gemini down')).mockResolvedValue({ ok: true, cached: false, summary: 's' });
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(await runWeeklyReports(deps(), NOW)).toEqual({ generated: 1, skipped: 1, failed: 1 });
    expect(JSON.parse(spy.mock.calls[0][0] as string)).toMatchObject({ msg: 'weekly_report_failed', userId: 'pro', currency: 'INR' });
    spy.mockRestore();
  });

  it('sends nothing when the insight was cached or could not be generated', async () => {
    generate.mockResolvedValueOnce({ ok: true, cached: true }).mockResolvedValueOnce({ ok: false });
    const result = await runWeeklyReports(deps(), NOW);
    expect(result).toMatchObject({ generated: 0, skipped: 3 }); // cached + not generated + opted out
    expect(sendEmail).not.toHaveBeenCalled();
  });
});

describe('defaultWeeklyDeps', () => {
  it('wires the weekly plan and the per-currency generator of the insights feature', async () => {
    const d = await defaultWeeklyDeps();
    expect(typeof d.plan).toBe('function');
    expect(typeof d.generate).toBe('function');
    // The first dynamic import of the insights feature takes over 5 s when the whole suite runs in parallel.
  }, 30_000);
});
