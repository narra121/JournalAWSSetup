# TradeQut backend

Trading journal API: Cognito auth, DynamoDB, S3, Stripe billing, Gemini AI features.

```
Browser ─> CloudFront (api.tradequt.com, OAC, SigV4) ─> Lambda Web Function  (Hono app, nodejs24.x, all /v1 routes)
Cognito triggers · Trades stream · schedules       ─> Lambda Event Function (one dispatcher)
```

- **Web Function** `tradequt-<stage>-api`: one Hono app (`src/app`). Cognito JWTs are verified in-process
  (`aws-jwt-verify`), admin tokens by the admin authorizer logic, CORS replicates the former API Gateway configuration.
  Existing handlers under `src/handlers/*` run unchanged behind an adapter (`src/app/http/adapter.ts`).
- **Event Function** `tradequt-<stage>-events` (`src/app/events.ts`): Cognito PreSignUp/PostConfirmation, the Trades
  DynamoDB stream (daily stats, balances, screenshot cleanup), the 6-hourly stats rebuild, daily lifecycle e-mails and the
  weekly insights job.
- **Monetization** (`src/app/billing`): `computeEntitlements` (Free / 14-day trial / Pro), monthly quotas in the `Usage`
  table, `GET /v1/me/entitlements`, Stripe Checkout and Customer Portal, 402 `QUOTA_EXCEEDED` / `PLAN_REQUIRED`.
- **Features** (`src/features`, import / insights / chat) are mounted under `/v1` behind auth + entitlements.
- **Privacy**: `GET /v1/auth/export`, `DELETE /v1/auth/account` (shared purge incl. screenshots and Stripe).

## Develop

```
bun install
bun run test            # vitest
bunx tsc --noEmit       # typecheck
sam validate --lint     # needs aws-sam-cli >= 1.172.1 and cfn-lint >= 1.60.0
bun run dev             # local server on :3001 (same app), needs AWS credentials + table/bucket env vars
bun run build           # dist/web.zip, dist/events.zip (deterministic)
```

## Deploy

`node scripts/deploy.mjs --stage dev|prod [--dry-run] [--confirm-prod] [--param Key=Value ...]` — prints the final parameter table, refuses prod without `AlarmEmail` and `/tradequt/prod/` admin, Stripe and ad-config parameter names; change set with a guard that aborts when a table,
user pool, user pool client, bucket or hosted zone would be removed or replaced; DynamoDB backups first; smoke check after.
See `docs/runbooks/operations.md` (day-to-day), `docs/runbooks/prod-cutover.md` (prod cut-over and rollback) and
`docs/runbooks/stripe-live.md`.

## API

`docs/openapi.yaml` is generated from the route table: `bun scripts/gen-openapi.ts`. Success bodies are
`{ success: true, message, data }`. `scripts/contract-test.mjs` records and compares status and JSON key shapes of every
route (used around every deploy).

### Error contract

Every non-2xx response, from every route, middleware and helper, has this body (`src/shared/apiError.ts`; the
`errorContract` middleware in `src/app/http/errors.ts` rewrites anything else, so no handler can send another shape):

```json
{
  "success": false,
  "message": "A trade can have at most 6 images",
  "errorCode": "VALIDATION_ERROR",
  "errorMessage": "A trade can have at most 6 images",
  "error": { "code": "VALIDATION_ERROR", "fields": [{ "field": "images", "message": "Images can have at most 6 items" }] },
  "requestId": "..."
}
```

| Field | Meaning |
|---|---|
| `message` | Plain text for a trader, safe to show as is; never empty; never raw AWS, Cognito, Stripe, Gemini or DynamoDB text |
| `errorCode` | Stable `UPPER_SNAKE_CASE` code (`VALIDATION_ERROR`, `UNAUTHORIZED`, `RATE_LIMITED`, `QUOTA_EXCEEDED`, `ROUTE_NOT_FOUND`, ...) |
| `errorMessage` | Always equal to `message` (older clients) |
| `error` | The one place for machine-readable extras; absent when there are none. `error.code` repeats `errorCode` |
| `error.retryAfter` | 429 only: seconds to wait (the `Retry-After` header carries the same number) |
| `error.fields` | 400 validation: `[{ field, message }]`, one per problem; `message` is the first one, plus " (and N more)" |
| `error.feature`, `limit`, `used`, `resetsAt`, `plan`, `requiredPlan`, `allowedAccountIds` | 402 `QUOTA_EXCEEDED` / `PLAN_REQUIRED` |
| `requestId` | 500 only: matches the access-log line |

Unknown routes answer `404 ROUTE_NOT_FOUND`. Chat streams report a failure after the first byte as an SSE
`event: error` with `{ code, message }`.

Responses AWS generates itself cannot carry this body: they are HTML or plain text. CloudFront Functions do not run on
origin 4xx/5xx, and a CloudFront custom error response would also replace the app's own JSON for the same status. This covers
the Lambda Web Function throttle `429` (HTML, seen on a cold burst of 300 requests; the `live` endpoint allows 100 requests/s
on dev, 300 on prod) and CloudFront's own pages (`405` for TRACE and `414` for URLs over 8 KB were measured; `502`/`504` for an
unreachable or too slow origin could not be reproduced). `ApiResponseHeadersPolicy` in `template.yaml` (managed security headers
plus CORS, `OriginOverride: false`) is on both cache behaviors so responses that come back from the Web Function endpoint keep
CORS headers; the pages CloudFront produces without asking the origin carry none (measured on the 405 and 414), so a browser
reports those as a network failure. Clients must treat a non-JSON error body as "message unknown" and show text for the status.

## Layout

```
src/app/            Hono app, auth, CORS, billing, account, journal, goals history, uploads, events entry
src/handlers/       one folder per route / job (API Gateway v2 event in, proxy result out)
src/features/       import, insights, chat (separate owner)
src/shared/         DynamoDB, validation, metrics, stats aggregation, e-mail, Stripe config, soft delete
src/schemas/        JSON schemas
scripts/            build, deploy, backup, contract test, Stripe setup, OpenAPI generator
infra/              artifacts bucket stack, rollback template
docs/               openapi.yaml, runbooks
template.yaml       SAM/CloudFormation for tradequt-<stage>
```
