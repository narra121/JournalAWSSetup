import type { Computed, Finding, Metric } from './metrics';

export type SectionKind = 'strength' | 'leak' | 'pattern' | 'action';
export interface InsightSection {
  kind: SectionKind;
  title: string;
  body: string;
  metric?: Metric;
  tradeIds?: string[];
}

const KINDS: SectionKind[] = ['strength', 'leak', 'pattern', 'action'];
export const MAX_SECTIONS = 8;
export const MIN_SECTIONS = 3;
const clamp = (s: unknown, n: number) => (typeof s === 'string' ? s.replace(/\s+/g, ' ').trim().slice(0, n) : '');

function actionFor(f: Finding): { title: string; body: string } {
  const r = f.metricRef;
  if (r === 'noStopNet') return { title: 'Set a stop before every entry', body: 'Decide and record a stop loss before entering each trade, so risk per trade is known and the R-multiple can be measured.' };
  if (r === 'revengeNet') return { title: 'Pause after a loss', body: 'After a losing trade, wait at least 15 minutes and re-check your setup before opening the next trade.' };
  if (r === 'overtradingNet') return { title: 'Cap trades per day', body: 'Set a maximum number of trades per day and stop for the day when you reach it or after your daily loss limit.' };
  if (r === 'fees') return { title: 'Reduce small, frequent trades', body: 'Fees take a large share of profit. Fewer, higher-quality trades lower the cost per trade.' };
  if (r === 'maxLossStreak') return { title: 'Step back after a losing streak', body: 'After three losses in a row, stop trading for the session and review those trades before the next one.' };
  if (r.startsWith('mistake.')) return { title: 'Add a pre-trade check', body: `Add a short checklist item before entry that prevents this mistake: ${f.title.replace(/^Mistake: /, '')}.` };
  if (r.startsWith('rule.')) return { title: 'Review the broken rule before trading', body: `Read this rule before each session: ${f.title.replace(/^Broken rule: /, '')}.` };
  return { title: 'Review these trades before the next session', body: 'Go through the listed trades, note what they have in common, and reduce size in this area until the pattern is fixed.' };
}

/**
 * Turns the model's JSON into an Insight body. Anything the model cannot be trusted with is replaced by our data:
 * metric values come from `metrics`, trade ids are limited to the user's own, and a missing strength/leak/action
 * is filled from the deterministic candidates.
 */
export function validateInsight(raw: unknown, c: Computed): { summary: string; sections: InsightSection[] } {
  const obj = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const byFinding = new Map(c.candidates.map((f) => [f.id, f]));
  const allCited = new Set(c.candidates.flatMap((f) => f.tradeIds));
  const sections: InsightSection[] = [];

  for (const s of Array.isArray(obj.sections) ? obj.sections : []) {
    if (!s || typeof s !== 'object') continue;
    const o = s as Record<string, unknown>;
    if (!KINDS.includes(o.kind as SectionKind)) continue;
    const title = clamp(o.title, 80);
    const body = clamp(o.body, 600);
    if (!title || !body) continue;
    const finding = typeof o.findingId === 'string' ? byFinding.get(o.findingId) : undefined;
    const ref = typeof o.metricRef === 'string' && c.metrics[o.metricRef] ? o.metricRef : finding?.metricRef;
    const ids = finding ? finding.tradeIds : (Array.isArray(o.tradeIds) ? o.tradeIds : []).filter((t): t is string => typeof t === 'string' && c.tradeIds.has(t) && allCited.has(t)).slice(0, 5);
    sections.push({ kind: o.kind as SectionKind, title, body, ...(ref ? { metric: c.metrics[ref] } : {}), ...(ids.length ? { tradeIds: ids } : {}) });
    if (sections.length === MAX_SECTIONS) break;
  }

  const has = (k: SectionKind) => sections.some((s) => s.kind === k);
  const fromFinding = (f: Finding, kind: SectionKind): InsightSection => ({ kind, title: f.title.slice(0, 80), body: f.detail.slice(0, 600), metric: c.metrics[f.metricRef], ...(f.tradeIds.length ? { tradeIds: f.tradeIds } : {}) });

  if (!has('strength')) {
    const f = c.candidates.find((x) => x.kind === 'strength');
    const m = c.metrics.largestWin;
    sections.push(
      f
        ? fromFinding(f, 'strength')
        : m?.value != null
          ? { kind: 'strength', title: 'Your best trade', body: `Your largest win in this period was ${m.display}. Review what you did right on it and repeat the process.`, metric: m }
          : { kind: 'strength', title: 'You are keeping a journal', body: `${c.metrics.trades.display} trades are recorded for this period, which gives you data to review.`, metric: c.metrics.trades },
    );
  }
  if (!has('leak')) {
    const f = c.candidates.find((x) => x.kind === 'leak');
    const m = c.metrics.largestLoss;
    sections.push(
      f
        ? fromFinding(f, 'leak')
        : m?.value != null
          ? { kind: 'leak', title: 'Your largest loss', body: `Your largest loss in this period was ${m.display}. Check whether it followed your plan.`, metric: m }
          : { kind: 'leak', title: 'No losing trades', body: 'There were no losing trades in this period; watch for overconfidence and keep sizing consistent.', metric: c.metrics.losses },
    );
  }
  if (!has('action')) {
    const f = c.candidates.find((x) => x.kind !== 'strength') ?? c.candidates[0];
    const a = f ? actionFor(f) : { title: 'Review your worst trades', body: 'Before the next session, review your three worst trades from this period and note what you would change.' };
    sections.push({ kind: 'action', ...a, ...(f ? { metric: c.metrics[f.metricRef] } : {}), ...(f?.tradeIds.length ? { tradeIds: f.tradeIds } : {}) });
  }
  while (sections.length < MIN_SECTIONS) {
    const used = new Set(sections.map((s) => s.title));
    const f = c.candidates.find((x) => !used.has(x.title.slice(0, 80)));
    if (!f) break;
    sections.push(fromFinding(f, f.kind));
  }

  const m = c.metrics;
  const summary = clamp(obj.summary, 400) || `${m.trades.display} trades, net ${m.netPnl.display}, win rate ${m.winRate.display}.`;
  return { summary, sections: sections.slice(0, MAX_SECTIONS) };
}
