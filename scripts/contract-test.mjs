// Probes every legacy route and records / compares status + JSON key shape. Never prints credentials.
// Usage:
//   node scripts/contract-test.mjs --record <file> [--api https://api-dev.tradequt.com/v1]
//   node scripts/contract-test.mjs --compare <file> [--api ...]
// QA login: <research>/secrets/dev-qa.json ({ email, passwordFile }). Mutating subscription routes are probed unauthenticated only.
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const research = process.env.TRADEQUT_RESEARCH || 'C:\\Users\\narpra1\\Work\\Personal\\TradeQut-Research';
const arg = (n) => (process.argv.includes(`--${n}`) ? process.argv[process.argv.indexOf(`--${n}`) + 1] : undefined);
const api = arg('api') || 'https://api-dev.tradequt.com/v1';
const recordFile = arg('record');
const compareFile = arg('compare');
if (!recordFile && !compareFile) throw new Error('--record <file> or --compare <file> required');

const routes = JSON.parse(readFileSync(join(root, 'src', 'app', '__tests__', 'routes.fixture.json'), 'utf8'));

async function call(method, path, { token, body } = {}) {
  const res = await fetch(api + path, {
    method,
    redirect: 'manual',
    headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    /* non-JSON body */
  }
  return { status: res.status, json, text };
}

async function qaToken() {
  const j = JSON.parse(readFileSync(join(research, 'secrets', 'dev-qa.json'), 'utf8'));
  const password = readFileSync(j.passwordFile, 'utf8').trim();
  const res = await call('POST', '/auth/login', { body: { email: j.email, password } });
  if (res.status !== 200) throw new Error(`QA login failed: ${res.status}`);
  const d = res.json?.data ?? res.json;
  return d.IdToken ?? d.idToken;
}

const shapeOf = (json) => {
  if (!json || typeof json !== 'object') return [];
  const keys = Object.keys(json).sort();
  const data = json.data && typeof json.data === 'object' && !Array.isArray(json.data) ? Object.keys(json.data).sort().map((k) => `data.${k}`) : [];
  return [...keys, ...data];
};

const SKIP_AUTHED = new Set(['PUT /v1/subscriptions', 'PATCH /v1/subscriptions', 'DELETE /v1/subscriptions', 'POST /v1/subscriptions']);
const concrete = (p) => p.replace(/\{[^}+]+\+?\}/g, 'contract-probe-0000');

const token = await qaToken();
const result = {};
for (const r of routes) {
  const key = `${r.method} ${r.path}`;
  const path = concrete(r.path.replace(/^\/v1/, ''));
  const body = ['GET', 'HEAD'].includes(r.method) ? undefined : {};
  const unauth = await call(r.method, path, { body });
  const entry = { unauth: unauth.status, unauthShape: shapeOf(unauth.json) };
  if (r.auth === 'cognito' && !SKIP_AUTHED.has(key)) {
    const authed = await call(r.method, path, { token, body });
    entry.authed = authed.status;
    entry.authedShape = shapeOf(authed.json);
  }
  result[key] = entry;
}

if (recordFile) {
  writeFileSync(recordFile, JSON.stringify({ api, at: new Date().toISOString(), routes: result }, null, 2));
  console.log(`recorded ${Object.keys(result).length} routes -> ${recordFile}`);
  process.exit(0);
}

const before = JSON.parse(readFileSync(compareFile, 'utf8')).routes;
const diffs = [];
for (const [key, now] of Object.entries(result)) {
  const was = before[key];
  if (!was) continue;
  for (const f of ['unauth', 'authed']) {
    if (was[f] !== now[f]) diffs.push(`${key}: ${f} status ${was[f]} -> ${now[f]}`);
  }
  for (const f of ['unauthShape', 'authedShape']) {
    const lost = (was[f] || []).filter((k) => !(now[f] || []).includes(k));
    if (lost.length) diffs.push(`${key}: ${f} lost keys ${lost.join(',')}`);
  }
}
console.log(`compared ${Object.keys(result).length} routes, ${diffs.length} differences`);
for (const d of diffs) console.log('DIFF', d);
process.exit(diffs.length ? 1 : 0);
