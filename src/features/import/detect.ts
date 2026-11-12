import { PARSERS } from './registry';
import type { ImportParser, Tabular } from './types';

/** Highest-scoring broker parser; the generic CSV parser never wins auto-detection. */
export function detectParser(t: Tabular): ImportParser | null {
  let best: ImportParser | null = null;
  let bestScore = 0;
  for (const p of PARSERS) {
    if (p.id === 'generic_csv') continue;
    const s = p.detect(t);
    if (s > bestScore) {
      best = p;
      bestScore = s;
    }
  }
  return best;
}
