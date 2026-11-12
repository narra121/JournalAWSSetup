// Argument handling for scripts/deploy.mjs (pure functions, unit-tested in src/test/deploy-args.test.ts).

/** Parameters the script computes itself; an operator cannot override them. */
export const MANAGED_PARAMS = new Set(['CodeBucket', 'WebCodeKey', 'WebCodeVersion', 'EventsCodeKey', 'EventsCodeVersion']);

/**
 * Parses `--stage dev|prod`, boolean flags and repeatable `--param Key=Value`.
 * Throws a readable Error on anything malformed.
 */
export function parseDeployArgs(argv) {
  const flags = new Set();
  const params = {};
  let stage;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--stage') {
      stage = argv[++i];
    } else if (a === '--param') {
      const raw = argv[++i];
      const eq = raw === undefined ? -1 : raw.indexOf('=');
      if (eq < 1) throw new Error(`--param needs Key=Value, got ${JSON.stringify(raw)}`);
      const key = raw.slice(0, eq);
      if (!/^[A-Za-z][A-Za-z0-9]*$/.test(key)) throw new Error(`--param key ${JSON.stringify(key)} is not a CloudFormation parameter name`);
      if (MANAGED_PARAMS.has(key)) throw new Error(`--param ${key} is set by the script and cannot be overridden`);
      if (key in params) throw new Error(`--param ${key} given twice`);
      params[key] = raw.slice(eq + 1);
    } else if (a.startsWith('--')) {
      flags.add(a.slice(2));
    } else {
      throw new Error(`unexpected argument ${JSON.stringify(a)}`);
    }
  }
  if (stage !== 'dev' && stage !== 'prod') throw new Error('--stage dev|prod required');
  return { stage, flags, params };
}

/** Checks that every --param key is declared by the template. */
export function assertDeclared(params, declared) {
  const unknown = Object.keys(params).filter((k) => !declared.has(k));
  if (unknown.length) throw new Error(`--param not declared by template.yaml: ${unknown.join(', ')}`);
}

/**
 * Rules for the prod stack. `effective` maps parameter name → the value the stack will have after the update
 * (explicit --param, else the previous value, else the template default). Returns the list of problems.
 */
export function prodParamProblems(effective) {
  const problems = [];
  const alarm = (effective.AlarmEmail ?? '').trim();
  if (!alarm) problems.push('AlarmEmail is empty: alarms would have no subscriber (pass --param AlarmEmail=<address>)');
  else if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(alarm)) problems.push(`AlarmEmail is not an e-mail address: ${alarm}`);
  for (const key of ['AdminSecretParamName', 'AdminJwtSecretParamName']) {
    const value = effective[key] ?? '';
    if (!value.startsWith('/tradequt/prod/')) {
      problems.push(`${key} is ${JSON.stringify(value)}: it must be under /tradequt/prod/ (pass --param ${key}=/tradequt/prod/<name>)`);
    }
  }
  return problems;
}

/** Fixed-width table of the final parameters; NoEcho values are masked. */
export function formatParamTable(rows) {
  const shown = rows.map((r) => ({ ...r, value: r.noEcho ? '****' : String(r.value ?? '') }));
  const w = (k) => Math.max(k.length, ...shown.map((r) => String(r[k]).length));
  const [wn, wv, ws] = [w('name'), w('value'), w('source')];
  const line = (n, v, s) => `${n.padEnd(wn)}  ${v.padEnd(wv)}  ${s.padEnd(ws)}`;
  return [line('PARAMETER', 'VALUE', 'SOURCE'), line('-'.repeat(wn), '-'.repeat(wv), '-'.repeat(ws)), ...shown.map((r) => line(r.name, r.value, r.source))].join('\n');
}
