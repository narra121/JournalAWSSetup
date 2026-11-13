const NUMERIC = ['fees', 'grossPnl', 'contractMultiplier', 'strike'];
const TEXT = ['assetClass', 'underlying', 'optionType', 'expiry', 'externalId', 'importSource', 'importBatchId'];

/** CONTRACT §6 optional fields (plus importBatchId). */
export const CONTRACT_FIELDS = [...NUMERIC, ...TEXT];

/** The CONTRACT §6 fields present in `t` with a value; absent, null and '' are left out. */
export function contractFields(t: any): Record<string, any> {
  const out: Record<string, any> = {};
  for (const f of NUMERIC) if (t[f] !== undefined && t[f] !== null && t[f] !== '') out[f] = Number(t[f]);
  for (const f of TEXT) if (typeof t[f] === 'string' && t[f] !== '') out[f] = t[f];
  return out;
}
