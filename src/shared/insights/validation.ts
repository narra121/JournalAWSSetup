// ---- Types ----

export interface InsightsResponse {
  profile: {
    type: 'scalper' | 'day_trader' | 'swing_trader' | 'conservative';
    typeLabel: string;
    aggressivenessScore: number;
    aggressivenessLabel: string;
    trend: string | null;
    summary: string;
  };
  scores: Array<{
    dimension: string;
    value: number;
    label: string;
  }>;
  insights: Array<{
    severity: 'critical' | 'warning' | 'info' | 'strength';
    title: string;
    detail: string;
    evidence: string;
    tradeIds?: string[];
  }>;
  tradeSpotlights: Array<{
    tradeId: string;
    symbol: string;
    date: string;
    pnl: number;
    reason: string;
  }>;
  summary: string;
}

// ---- JSON Extraction ----

export function extractJsonObject(raw: string): { json?: string; steps: string[] } {
  const steps: string[] = [];
  let work = raw.trim();

  // Strip markdown code fences if present
  const fenceMatch = work.match(/```(?:json)?\s*[\r\n]+([\s\S]*?)```/i);
  if (fenceMatch) {
    steps.push('Stripped markdown code fence');
    work = fenceMatch[1].trim();
  }

  // Direct check for JSON object
  if (work.startsWith('{') && work.endsWith('}')) {
    steps.push('Detected object boundaries directly');
    return { json: work, steps };
  }

  // Bracket balancing to find first JSON object
  const firstOpen = work.indexOf('{');
  if (firstOpen !== -1) {
    let depth = 0;
    for (let i = firstOpen; i < work.length; i++) {
      const ch = work[i];
      if (ch === '{') depth++;
      else if (ch === '}') {
        depth--;
        if (depth === 0) {
          const candidate = work.slice(firstOpen, i + 1).trim();
          if (candidate.startsWith('{') && candidate.endsWith('}')) {
            steps.push('Extracted balanced object slice');
            return { json: candidate, steps };
          }
          break;
        }
      }
    }
  }

  return { steps };
}

// ---- Response Validation ----

export function validateInsightsResponse(data: any): data is InsightsResponse {
  if (!data || typeof data !== 'object') return false;

  // Validate profile
  if (!data.profile || typeof data.profile !== 'object') return false;
  const validTypes = ['scalper', 'day_trader', 'swing_trader', 'conservative'];
  if (!validTypes.includes(data.profile.type)) return false;
  if (typeof data.profile.aggressivenessScore !== 'number') return false;
  if (typeof data.profile.summary !== 'string') return false;

  // Validate scores array
  if (!Array.isArray(data.scores) || data.scores.length === 0) return false;
  for (const score of data.scores) {
    if (typeof score.dimension !== 'string') return false;
    if (typeof score.value !== 'number') return false;
  }

  // Validate insights array
  if (!Array.isArray(data.insights)) return false;
  const validSeverities = ['critical', 'warning', 'info', 'strength'];
  for (const insight of data.insights) {
    if (!validSeverities.includes(insight.severity)) return false;
    if (typeof insight.title !== 'string') return false;
    if (typeof insight.detail !== 'string') return false;
  }

  // Validate tradeSpotlights array
  if (!Array.isArray(data.tradeSpotlights)) return false;

  // Validate summary
  if (typeof data.summary !== 'string') return false;

  return true;
}
