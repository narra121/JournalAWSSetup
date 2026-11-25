import { SESClient, SendEmailCommand } from '@aws-sdk/client-ses';
import { GetParameterCommand, SSMClient } from '@aws-sdk/client-ssm';
import { findCognitoUserBySub } from './cognitoUser';

const ses = new SESClient({});
const ssm = new SSMClient({});

let poolId: string | undefined;

/** The Event Function cannot reference the user pool directly (cycle), so it reads the id from SSM. */
async function userPoolId(): Promise<string> {
  if (process.env.USER_POOL_ID) return process.env.USER_POOL_ID;
  poolId ??= (await ssm.send(new GetParameterCommand({ Name: process.env.USER_POOL_ID_PARAM! }))).Parameter?.Value;
  if (!poolId) throw new Error('user pool id not available');
  return poolId;
}

/** The user's e-mail address from Cognito, or null when the user no longer exists or has none. */
export async function getUserEmail(userId: string): Promise<string | null> {
  const user = await findCognitoUserBySub(await userPoolId(), userId);
  return user?.Attributes?.find((a) => a.Name === 'email')?.Value ?? null;
}

export interface Mail {
  to: string;
  subject: string;
  text: string;
  html: string;
}

export async function sendEmail(mail: Mail): Promise<void> {
  await ses.send(
    new SendEmailCommand({
      Source: process.env.FROM_EMAIL!,
      Destination: { ToAddresses: [mail.to] },
      Message: {
        Subject: { Data: mail.subject, Charset: 'UTF-8' },
        Body: { Text: { Data: mail.text, Charset: 'UTF-8' }, Html: { Data: mail.html, Charset: 'UTF-8' } },
      },
    }),
  );
}

const appUrl = () => process.env.APP_URL || 'https://tradequt.com';

const layout = (body: string, footer: string) =>
  `<div style="font-family:Arial,sans-serif;max-width:520px;margin:auto;color:#111">${body}<p style="color:#666;font-size:12px;margin-top:32px">${footer}</p></div>`;

const TRANSACTIONAL_FOOTER = 'You get this message because it concerns your TradeQut account.';

/** The app's Notifications section (TradeFlow SettingsView route `settings/notifications`; `/app/settings` alone opens Profile). */
const notificationsUrl = () => `${appUrl()}/app/settings/notifications`;

/** Non-transactional mails carry the way to switch them off (Settings → Notifications). */
const optionalFooter = () =>
  `You can turn these emails off in <a href="${notificationsUrl()}">Settings → Notifications</a>.`;

const SUPPORT_EMAIL = 'support@tradequt.com';

const escapeHtml = (text: string) =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

/** Sent once, when the account is confirmed. `trialEndsOn` is YYYY-MM-DD. */
export function welcomeMail(to: string, trialEndsOn: string): Mail {
  const start = `${appUrl()}/app/dashboard`;
  const guide = `${appUrl()}/guide#importing-trades`;
  return {
    to,
    subject: 'Your TradeQut journal is ready',
    text: `Your TradeQut account is confirmed and your free trial has started. Every feature is on until ${trialEndsOn}, and no card is needed.\n\nThree steps set up the journal:\n1. Create your trading account: a name and a starting balance are enough.\n2. Get your trades in: upload the file your broker or platform exports (a MetaTrader 4 or 5 report, an Indian broker trade file or any CSV) or a screenshot of your trades, or add a trade by hand.\n3. Set a weekly goal and your rules (optional).\n\nStart here: ${start}\nHow to export and import a file: ${guide}\n\nWhen the trial ends nothing is charged and your journal becomes read-only until you upgrade to Pro.\n\nQuestions: ${SUPPORT_EMAIL}\n\n${TRANSACTIONAL_FOOTER}`,
    html: layout(
      `<h2>Your journal is ready</h2><p>Your TradeQut account is confirmed and your free trial has started. Every feature is on until ${trialEndsOn}, and no card is needed.</p><p>Three steps set up the journal:</p><ol><li>Create your trading account: a name and a starting balance are enough.</li><li>Get your trades in: upload the file your broker or platform exports (a MetaTrader 4 or 5 report, an Indian broker trade file or any CSV) or a screenshot of your trades, or add a trade by hand.</li><li>Set a weekly goal and your rules (optional).</li></ol><p><a href="${start}">Set up your journal</a></p><p><a href="${guide}">How to export and import a file</a></p><p>When the trial ends nothing is charged and your journal becomes read-only until you upgrade to Pro.</p><p>Questions: <a href="mailto:${SUPPORT_EMAIL}">${SUPPORT_EMAIL}</a></p>`,
      TRANSACTIONAL_FOOTER,
    ),
  };
}

/** A getting-started mail of the first trial week. These are optional mails, so each carries the switch-off link. */
function howToMail(to: string, subject: string, intro: string, steps: string[], link: { label: string; url: string }): Mail {
  return {
    to,
    subject,
    text: `${intro}\n\n${steps.map((step, i) => `${i + 1}. ${step}`).join('\n')}\n\n${link.label}: ${link.url}\n\nQuestions: ${SUPPORT_EMAIL}\n\nYou can turn these emails off in Settings: ${notificationsUrl()}`,
    html: layout(
      `<h2>${escapeHtml(subject)}</h2><p>${escapeHtml(intro)}</p><ol>${steps.map((step) => `<li>${escapeHtml(step)}</li>`).join('')}</ol><p><a href="${link.url}">${escapeHtml(link.label)}</a></p><p>Questions: <a href="mailto:${SUPPORT_EMAIL}">${SUPPORT_EMAIL}</a></p>`,
      optionalFooter(),
    ),
  };
}

const journalLink = () => ({ label: 'Open your journal', url: `${appUrl()}/app/dashboard` });

export function firstTradesMail(to: string): Mail {
  return howToMail(
    to,
    'Get your first trades into TradeQut',
    'Your journal has no trades yet. A file from your broker or trading platform is the quickest way in.',
    [
      'Export your trade history from your broker or platform. The import page shows the export steps for each one it reads.',
      'Open your journal and drop the file on step 2. Check the rows, then save.',
      'No export file? Upload a screenshot of your trades, or add a trade by hand.',
    ],
    journalLink(),
  );
}

export function otherWaysMail(to: string): Mail {
  return howToMail(
    to,
    'Three ways to get trades into TradeQut',
    'Your journal is still empty. Any one of these gets your trades in.',
    [
      'A broker or platform file: the import page shows the export steps for each one it reads.',
      'Any other CSV: choose the generic CSV source and map your columns.',
      'A screenshot of your trades, or a trade typed in by hand.',
    ],
    journalLink(),
  );
}

export function tagTradesMail(to: string): Mail {
  return howToMail(
    to,
    'See what each mistake costs you',
    'Your trades are in. Tags turn them into answers.',
    [
      'Open a trade and tag its setup, the mistakes you made and the rules you broke.',
      'Open Analytics to see which setups, hours and habits make or lose money.',
      'Set a weekly goal and your rules under Goals.',
    ],
    { label: 'Open Analytics', url: `${appUrl()}/app/analytics` },
  );
}

export function weekReviewMail(to: string): Mail {
  return howToMail(
    to,
    'Review your first week in TradeQut',
    'A week of trades is enough for a first review.',
    [
      'Open Insights and generate a report on your trades.',
      'Ask the chat a question about your own trades, for example which setup lost the most.',
      'Check the week against your goals and rules under Goals.',
    ],
    { label: 'Open Insights', url: `${appUrl()}/app/insights` },
  );
}

export function trialEndingMail(to: string, endsOn: string): Mail {
  const url = `${appUrl()}/app/billing`;
  return {
    to,
    subject: 'Your TradeQut free trial ends in 3 days',
    text: `Your free trial ends on ${endsOn}. After that your journal is read-only: you can view and export your trades, but not add, edit or delete them. Upgrade to Pro to keep everything working.\n\nPlans and billing: ${url}\n\n${TRANSACTIONAL_FOOTER}`,
    html: layout(
      `<h2>Your free trial ends on ${endsOn}</h2><p>After that your journal is read-only: you can view and export your trades, but not add, edit or delete them. Upgrade to Pro to keep everything working.</p><p><a href="${url}">See plans</a></p>`,
      TRANSACTIONAL_FOOTER,
    ),
  };
}

export function trialEndedMail(to: string): Mail {
  const url = `${appUrl()}/app/billing`;
  return {
    to,
    subject: 'Your TradeQut free trial has ended',
    text: `Your journal is now read-only. All your trades are safe, and you can still view and export them. What changed: adding, editing and deleting trades, imports, notes, rules, AI reports and chat need Pro. Upgrade to Pro: ${url}\n\n${TRANSACTIONAL_FOOTER}`,
    html: layout(
      `<h2>Your journal is now read-only</h2><p>All your trades are safe, and you can still view and export them. Adding, editing and deleting trades, imports, notes, rules, AI reports and chat need Pro.</p><p><a href="${url}">Upgrade to Pro</a></p>`,
      TRANSACTIONAL_FOOTER,
    ),
  };
}

export function paymentFailedMail(to: string): Mail {
  const url = `${appUrl()}/app/billing`;
  return {
    to,
    subject: 'Your TradeQut payment failed',
    text: `Your last payment did not go through. Update your card to keep Pro: ${url} (use Manage billing).\n\n${TRANSACTIONAL_FOOTER}`,
    html: layout(
      `<h2>Your last payment failed</h2><p>Update your card to keep Pro.</p><p><a href="${url}">Manage billing</a></p>`,
      TRANSACTIONAL_FOOTER,
    ),
  };
}

export function weeklyReportMail(to: string, summary: string): Mail {
  const url = `${appUrl()}/app/insights`;
  return {
    to,
    subject: 'Your TradeQut weekly report is ready',
    text: `${summary}\n\nRead the full report: ${url}\n\nYou can turn these emails off in Settings: ${notificationsUrl()}`,
    html: layout(`<h2>Your weekly report is ready</h2><p>${escapeHtml(summary)}</p><p><a href="${url}">Read the full report</a></p>`, optionalFooter()),
  };
}
