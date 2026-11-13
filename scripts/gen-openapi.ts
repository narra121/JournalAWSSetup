// Generates docs/openapi.yaml from the route table (src/app/routes.ts) plus the routes the Hono app adds itself.
// Usage: bun scripts/gen-openapi.ts
import { writeFileSync } from 'node:fs';
import jsYaml from 'js-yaml';
import { LEGACY_ROUTES, type AuthGroup } from '../src/app/routes';

type Extra = { method: string; path: string; auth: AuthGroup; summary: string; gated?: 'quota' | 'plan' };

/** Routes registered in src/app/app.ts and the sub-apps under src/app (features' routes are listed under /import, /insights, /chat). */
const EXTRA: Extra[] = [
  { method: 'GET', path: '/v1/me/entitlements', auth: 'cognito', summary: 'Plan, limits, usage this month, reset date, billing currency, writable accounts' },
  { method: 'PUT', path: '/v1/me/writable-accounts', auth: 'cognito', summary: 'Choose which (at most 2) accounts stay writable on the Free plan', gated: 'plan' },
  { method: 'POST', path: '/v1/billing/checkout', auth: 'cognito', summary: 'Stripe Checkout session for Pro (interval month|year)' },
  { method: 'POST', path: '/v1/billing/portal', auth: 'cognito', summary: 'Stripe Customer Portal session' },
  { method: 'GET', path: '/v1/auth/export', auth: 'cognito', summary: 'Export all account data (JSON download)' },
  { method: 'DELETE', path: '/v1/auth/account', auth: 'cognito', summary: 'Delete the account and all data (irreversible)' },
  { method: 'POST', path: '/v1/auth/logout-all', auth: 'cognito', summary: 'Sign out of every session' },
  { method: 'POST', path: '/v1/uploads/images', auth: 'cognito', summary: 'Presigned PUT for one screenshot (png/jpeg/webp, at most 2 MiB)' },
  { method: 'POST', path: '/v1/trades/restore', auth: 'cognito', summary: 'Restore soft-deleted trades (30-day window)' },
  { method: 'POST', path: '/v1/trades/bulk-update', auth: 'cognito', summary: 'Apply one change set (set/add/remove) to up to 200 trades' },
  { method: 'GET', path: '/v1/goals/history', auth: 'cognito', summary: 'Goal results and rule compliance per past week or month' },
  { method: 'GET', path: '/v1/journal/days', auth: 'cognito', summary: 'Day notes (plan / review) in a date range' },
  { method: 'PUT', path: '/v1/journal/days/{date}', auth: 'cognito', summary: 'Create, update or clear one day note' },
];

const quota402 = { description: 'Monthly quota exhausted (errorCode QUOTA_EXCEEDED) or feature not in the plan (PLAN_REQUIRED)', content: { 'application/json': { schema: { $ref: '#/components/schemas/PaymentRequired' } } } };
const METERED = new Set(['POST /v1/trades/extract', 'POST /v1/enhance-text']);
const GATED = new Set([
  'POST /v1/accounts', 'PUT /v1/accounts/{accountId}', 'PATCH /v1/accounts/{accountId}/status',
  'POST /v1/trades', 'PUT /v1/trades/{tradeId}', 'DELETE /v1/trades/{tradeId}',
  'POST /v1/trades/bulk-update', 'POST /v1/trades/bulk-delete', 'POST /v1/trades/restore', 'GET /v1/stats',
]);

const security = (auth: AuthGroup) => (auth === 'public' ? [] : auth === 'admin' ? [{ AdminToken: [] }] : [{ CognitoToken: [] }]);
const toPath = (p: string) => p.replace('{imageId+}', '{imageId}');

const paths: Record<string, Record<string, unknown>> = {};
const add = (method: string, path: string, auth: AuthGroup, summary: string, can402: boolean) => {
  const key = toPath(path);
  (paths[key] ??= {})[method.toLowerCase()] = {
    summary,
    tags: [path.split('/')[2] ?? 'root'],
    security: security(auth),
    parameters: [...path.matchAll(/\{(\w+)\+?\}/g)].map((m) => ({ name: m[1], in: 'path', required: true, schema: { type: 'string' } })),
    responses: {
      '200': { description: 'Success', content: { 'application/json': { schema: { $ref: '#/components/schemas/Envelope' } } } },
      '400': { description: 'Validation error (error.fields lists each problem)', content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } } },
      ...(auth === 'public' ? {} : { '401': { description: 'Missing or invalid token', content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } } } }),
      ...(can402 ? { '402': quota402 } : {}),
      default: { description: 'Any other error (404, 409, 429 with error.retryAfter, 5xx): the same ApiError body', content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } } },
    },
  };
};

for (const r of LEGACY_ROUTES) {
  const k = `${r.method} ${r.path}`;
  add(r.method, r.path, r.auth, k, METERED.has(k) || GATED.has(k));
}
for (const e of EXTRA) add(e.method, e.path, e.auth, e.summary, !!e.gated);
add('GET', '/v1/import/sources', 'cognito', 'Supported broker file formats (features)', false);
add('POST', '/v1/import/parse', 'cognito', 'Parse a broker file (features; quota broker_import)', true);
add('GET', '/v1/insights', 'cognito', 'List saved AI insights (features)', false);
add('POST', '/v1/insights/generate', 'cognito', 'Generate an AI insight (features; quota ai_insight)', true);
add('GET', '/v1/insights/{id}', 'cognito', 'One saved AI insight (features)', false);
add('GET', '/v1/chat/sessions', 'cognito', 'List chat sessions (features)', false);
add('POST', '/v1/chat/sessions', 'cognito', 'Start a chat session (features)', false);
add('GET', '/v1/chat/sessions/{id}/messages', 'cognito', 'Messages of a chat session (features)', false);
add('DELETE', '/v1/chat/sessions/{id}', 'cognito', 'Delete a chat session (features)', false);
add('POST', '/v1/chat/sessions/{id}/messages', 'cognito', 'AI chat message, text/event-stream (features; quota ai_chat)', true);
add('GET', '/v1/reports/tax', 'cognito', 'Tax report for a financial year, ?fy=2026-27 (features; plan feature tax_report)', true);

const doc = {
  openapi: '3.0.3',
  info: {
    title: 'TradeQut API',
    version: '2.0.0',
    description: 'Generated by scripts/gen-openapi.ts from src/app/routes.ts. Success bodies are { success, message, data }; every non-2xx body is ApiError (README "API"). Unknown routes answer 404 ROUTE_NOT_FOUND.',
  },
  servers: [{ url: 'https://api.tradequt.com' }, { url: 'https://api-dev.tradequt.com' }],
  components: {
    securitySchemes: {
      CognitoToken: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT (Cognito id or access token, verified in-process)' },
      AdminToken: { type: 'http', scheme: 'bearer', bearerFormat: 'Admin JWT from POST /v1/admin/login' },
    },
    schemas: {
      Envelope: {
        type: 'object',
        required: ['success', 'message'],
        properties: {
          success: { type: 'boolean' },
          message: { type: 'string' },
          data: {},
        },
      },
      ApiError: {
        type: 'object',
        required: ['success', 'message', 'errorCode', 'errorMessage'],
        properties: {
          success: { type: 'boolean', enum: [false] },
          message: { type: 'string', description: 'Plain text for a trader, shown as is' },
          errorCode: { type: 'string', description: 'Stable UPPER_SNAKE_CASE code' },
          errorMessage: { type: 'string', description: 'Always equal to message (older clients)' },
          error: {
            type: 'object',
            description: 'The one place for machine-readable extras; absent when there are none',
            required: ['code'],
            properties: {
              code: { type: 'string', description: 'Same as errorCode' },
              retryAfter: { type: 'integer', description: '429: seconds to wait (also the Retry-After header)' },
              fields: { type: 'array', description: '400: one entry per invalid field', items: { type: 'object', required: ['field', 'message'], properties: { field: { type: 'string' }, message: { type: 'string' } } } },
              feature: { type: 'string', description: '402: the quota or plan feature' },
              plan: { type: 'string', enum: ['free', 'trial', 'pro'] },
              limit: { type: 'integer' },
              used: { type: 'integer' },
              resetsAt: { type: 'string', format: 'date-time' },
              requiredPlan: { type: 'string' },
              allowedAccountIds: { type: 'array', items: { type: 'string' } },
            },
          },
          requestId: { type: 'string', description: '5xx: matches the access log line' },
        },
      },
      PaymentRequired: {
        type: 'object',
        required: ['success', 'errorCode', 'error'],
        properties: {
          success: { type: 'boolean', enum: [false] },
          message: { type: 'string' },
          errorCode: { type: 'string', enum: ['QUOTA_EXCEEDED', 'PLAN_REQUIRED'] },
          error: {
            type: 'object',
            properties: {
              code: { type: 'string' },
              feature: { type: 'string' },
              plan: { type: 'string', enum: ['free', 'trial', 'pro'] },
              limit: { type: 'integer' },
              used: { type: 'integer' },
              resetsAt: { type: 'string', format: 'date-time' },
              requiredPlan: { type: 'string' },
              allowedAccountIds: { type: 'array', items: { type: 'string' } },
            },
          },
        },
      },
    },
  },
  paths: Object.fromEntries(Object.entries(paths).sort(([a], [b]) => a.localeCompare(b))),
};

writeFileSync('docs/openapi.yaml', jsYaml.dump(doc, { lineWidth: 120, noRefs: true }));
console.log(`wrote docs/openapi.yaml with ${Object.keys(doc.paths).length} paths`);
