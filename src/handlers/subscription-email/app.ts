// TODO: This handler is deployed but never invoked from any webhook or event source.
// Wire it up to stripe-webhook handlers or remove it.
import { SESClient, SendEmailCommand } from '@aws-sdk/client-ses';

const ses = new SESClient({});
const FROM_EMAIL = process.env.FROM_EMAIL || 'noreply@tradequt.com';
const APP_URL = process.env.APP_URL || 'https://tradequt.com';

type EmailReason =
  | 'payment_failed'
  | 'subscription_cancelled'
  | 'subscription_ended'
  | 'trial_expiring_soon';

interface EmailEvent {
  userId: string;
  email: string;
  name?: string;
  reason: EmailReason;
  planName?: string;
  nextChargeDate?: string;
  trialEndDate?: string;
}

/**
 * Sends subscription-related email notifications.
 * Called directly from the webhook handler or a scheduled cron Lambda.
 */
export const handler = async (event: EmailEvent): Promise<{ sent: boolean }> => {
  console.log('Sending subscription email:', { userId: event.userId, reason: event.reason });

  try {
    const { subject, htmlBody, textBody } = buildEmail(event);

    await ses.send(new SendEmailCommand({
      Source: `TradeQut <${FROM_EMAIL}>`,
      Destination: {
        ToAddresses: [event.email],
      },
      Message: {
        Subject: { Data: subject, Charset: 'UTF-8' },
        Body: {
          Html: { Data: htmlBody, Charset: 'UTF-8' },
          Text: { Data: textBody, Charset: 'UTF-8' },
        },
      },
    }));

    console.log('Email sent successfully', { userId: event.userId, reason: event.reason });
    return { sent: true };
  } catch (error: any) {
    console.error('Failed to send email:', { userId: event.userId, error: error.message });
    return { sent: false };
  }
};

function buildEmail(event: EmailEvent): { subject: string; htmlBody: string; textBody: string } {
  const name = event.name || 'Trader';
  const profileUrl = `${APP_URL}/app/profile`;

  switch (event.reason) {
    case 'payment_failed':
      return {
        subject: 'Action Required: Payment failed for your TradeQut subscription',
        textBody: `Hi ${name},\n\nYour latest payment for TradeQut Pro failed. Please update your payment method to continue using all features.\n\nUpdate payment: ${profileUrl}\n\nIf this was a mistake, no worries — just update your card and you're all set.\n\nBest,\nTradeQut Team`,
        htmlBody: emailTemplate({
          heading: 'Payment Failed',
          icon: '💳',
          message: `Hi ${name},<br><br>Your latest payment for <strong>TradeQut Pro</strong> failed. Your access will be restricted until the payment is resolved.`,
          ctaText: 'Update Payment Method',
          ctaUrl: profileUrl,
          footer: 'If this was a mistake, just update your card and you\'re all set.',
        }),
      };

    case 'subscription_cancelled':
      return {
        subject: 'Your TradeQut subscription has been cancelled',
        textBody: `Hi ${name},\n\nYour TradeQut Pro subscription has been cancelled. You can resubscribe anytime to regain full access.\n\nResubscribe: ${profileUrl}\n\nWe'd love to have you back!\n\nBest,\nTradeQut Team`,
        htmlBody: emailTemplate({
          heading: 'Subscription Cancelled',
          icon: '👋',
          message: `Hi ${name},<br><br>Your <strong>TradeQut Pro</strong> subscription has been cancelled. Your access to premium features has ended.`,
          ctaText: 'Resubscribe Now',
          ctaUrl: profileUrl,
          footer: 'We\'d love to have you back anytime!',
        }),
      };

    case 'subscription_ended':
      return {
        subject: 'Your TradeQut subscription has ended',
        textBody: `Hi ${name},\n\nYour TradeQut Pro subscription has ended. Resubscribe to continue using all features.\n\nResubscribe: ${profileUrl}\n\nBest,\nTradeQut Team`,
        htmlBody: emailTemplate({
          heading: 'Subscription Ended',
          icon: '⏰',
          message: `Hi ${name},<br><br>Your <strong>TradeQut Pro</strong> subscription period has ended. To continue using analytics, imports, goals, and other premium features, please resubscribe.`,
          ctaText: 'Renew Subscription',
          ctaUrl: profileUrl,
          footer: 'Your trade data is safe and waiting for you.',
        }),
      };

    case 'trial_expiring_soon':
      return {
        subject: 'Your TradeQut free trial ends in 3 days',
        textBody: `Hi ${name},\n\nYour 30-day free trial of TradeQut ends on ${event.trialEndDate || 'soon'}. Subscribe to keep full access to all features.\n\nSubscribe: ${profileUrl}\n\nBest,\nTradeQut Team`,
        htmlBody: emailTemplate({
          heading: 'Trial Ending Soon',
          icon: '⏳',
          message: `Hi ${name},<br><br>Your <strong>30-day free trial</strong> of TradeQut ends on <strong>${event.trialEndDate || 'soon'}</strong>. Subscribe now to keep using analytics, trade imports, goals, and all premium features.`,
          ctaText: 'Subscribe Now',
          ctaUrl: profileUrl,
          footer: 'Plans start at just $1.99/month or ₹99/month.',
        }),
      };

    default:
      return {
        subject: 'Update on your TradeQut account',
        textBody: `Hi ${name},\n\nThere's an update to your TradeQut account. Please check your profile.\n\nProfile: ${profileUrl}\n\nBest,\nTradeQut Team`,
        htmlBody: emailTemplate({
          heading: 'Account Update',
          icon: '📬',
          message: `Hi ${name},<br><br>There's an update to your TradeQut account. Please check your profile for details.`,
          ctaText: 'View Profile',
          ctaUrl: profileUrl,
          footer: '',
        }),
      };
  }
}

function emailTemplate(params: {
  heading: string;
  icon: string;
  message: string;
  ctaText: string;
  ctaUrl: string;
  footer: string;
}): string {
  return `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
<body style="margin:0;padding:0;background:#0a0a0f;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#0a0a0f;padding:40px 20px;">
    <tr><td align="center">
      <table width="600" cellpadding="0" cellspacing="0" style="background:#1a1a2e;border-radius:12px;border:1px solid rgba(255,255,255,0.1);overflow:hidden;">
        <!-- Header -->
        <tr><td style="padding:32px 32px 0;text-align:center;">
          <div style="font-size:40px;margin-bottom:8px;">${params.icon}</div>
          <h1 style="color:#10b981;font-size:24px;margin:0 0 8px;">${params.heading}</h1>
        </td></tr>
        <!-- Body -->
        <tr><td style="padding:24px 32px;color:#e0e0e0;font-size:16px;line-height:1.6;">
          ${params.message}
        </td></tr>
        <!-- CTA -->
        <tr><td style="padding:0 32px 24px;text-align:center;">
          <a href="${params.ctaUrl}" style="display:inline-block;background:#10b981;color:#fff;padding:14px 32px;border-radius:8px;text-decoration:none;font-weight:600;font-size:16px;">${params.ctaText}</a>
        </td></tr>
        <!-- Footer -->
        <tr><td style="padding:16px 32px 32px;color:#888;font-size:13px;text-align:center;border-top:1px solid rgba(255,255,255,0.05);">
          ${params.footer ? `<p style="margin:0 0 8px;">${params.footer}</p>` : ''}
          <p style="margin:0;">TradeQut — Your Professional Trading Journal</p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

/**
 * Helper to invoke this handler from other Lambdas (e.g., webhook handler).
 * Usage: await sendSubscriptionEmail({ userId, email, name, reason });
 */
export async function sendSubscriptionEmail(params: EmailEvent): Promise<void> {
  try {
    await handler(params);
  } catch (error) {
    console.error('sendSubscriptionEmail failed:', error);
  }
}
