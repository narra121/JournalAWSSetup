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

/** Non-transactional mails carry the way to switch them off (Settings → Notifications). */
const optionalFooter = () =>
  `You can turn these emails off in <a href="${appUrl()}/app/settings#notifications">Settings → Notifications</a>.`;

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

const escapeHtml = (text: string) =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

export function weeklyReportMail(to: string, summary: string): Mail {
  const url = `${appUrl()}/app/insights`;
  return {
    to,
    subject: 'Your TradeQut weekly report is ready',
    text: `${summary}\n\nRead the full report: ${url}\n\nYou can turn these emails off in Settings: ${appUrl()}/app/settings#notifications`,
    html: layout(`<h2>Your weekly report is ready</h2><p>${escapeHtml(summary)}</p><p><a href="${url}">Read the full report</a></p>`, optionalFooter()),
  };
}
