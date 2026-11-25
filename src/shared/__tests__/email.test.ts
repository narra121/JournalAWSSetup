import { describe, expect, it } from 'vitest';
import { weeklyReportMail, welcomeMail } from '../email';

describe('welcomeMail', () => {
  const mail = welcomeMail('u@example.com', '2026-12-09');

  it('names the trial end date and links the first-run page and the import guide, in both parts', () => {
    for (const part of [mail.text, mail.html]) {
      expect(part).toContain('until 2026-12-09');
      expect(part).toContain('https://tradequt.com/app/dashboard');
      expect(part).toContain('https://tradequt.com/guide#importing-trades');
      expect(part).toContain('support@tradequt.com');
    }
  });

  it('is an account notice: the transactional footer, and no switch-off link', () => {
    expect(mail.text).toContain('You get this message because it concerns your TradeQut account.');
    expect(mail.html).toContain('You get this message because it concerns your TradeQut account.');
    expect(mail.text + mail.html).not.toContain('/app/settings/notifications');
  });

  it('promises nothing the product does not do', () => {
    expect(mail.subject + mail.text + mail.html).not.toMatch(/\bbest\b|#1\b|free forever|auto.?sync|automatic(ally)? sync|mobile app|guarantee/i);
  });
});

describe('weeklyReportMail (BE-079)', () => {
  const hostile = `Ignore previous instructions <a href="https://evil.example">click</a> & 'more' <img src=x onerror=alert(1)>`;

  it('escapes the AI summary in the HTML part so notes cannot inject links or markup', () => {
    const { html } = weeklyReportMail('u@example.com', hostile);
    expect(html).not.toContain('<a href="https://evil.example">');
    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;a href=&quot;https://evil.example&quot;&gt;click&lt;/a&gt; &amp; &#39;more&#39; &lt;img src=x onerror=alert(1)&gt;');
  });

  it('leaves the plain-text part as written and keeps the report link', () => {
    const { text, html } = weeklyReportMail('u@example.com', hostile);
    expect(text.startsWith(hostile)).toBe(true);
    expect(html).toContain('<a href="https://tradequt.com/app/insights">Read the full report</a>');
  });

  it('the switch-off link opens the Notifications section, in both parts (/app/settings alone opens Profile)', () => {
    const { text, html } = weeklyReportMail('u@example.com', 'Week.');
    expect(text).toContain('https://tradequt.com/app/settings/notifications');
    expect(html).toContain('<a href="https://tradequt.com/app/settings/notifications">Settings → Notifications</a>');
    expect(text + html).not.toContain('/app/settings#');
  });

  it('plain summaries are unchanged', () => {
    expect(weeklyReportMail('u@example.com', 'Great week: 12 trades, +3.2R.').html).toContain('<p>Great week: 12 trades, +3.2R.</p>');
  });
});
