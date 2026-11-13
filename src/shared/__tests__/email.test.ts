import { describe, expect, it } from 'vitest';
import { weeklyReportMail } from '../email';

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

  it('plain summaries are unchanged', () => {
    expect(weeklyReportMail('u@example.com', 'Great week: 12 trades, +3.2R.').html).toContain('<p>Great week: 12 trades, +3.2R.</p>');
  });
});
