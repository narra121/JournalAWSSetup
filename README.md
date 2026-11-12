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

`node scripts/deploy.mjs --stage dev|prod [--dry-run] [--confirm-prod] [--param Key=Value ...]` — prints the final parameter table, refuses prod without `AlarmEmail` and `/tradequt/prod/` admin secret names; change set with a guard that aborts when a table,
user pool, user pool client, bucket or hosted zone would be removed or replaced; DynamoDB backups first; smoke check after.
See `docs/runbooks/operations.md` (day-to-day), `docs/runbooks/prod-cutover.md` (prod cut-over and rollback) and
`docs/runbooks/stripe-live.md`.

## API

`docs/openapi.yaml` is generated from the route table: `bun scripts/gen-openapi.ts`. All bodies use the envelope
`{ success, message, data, errorCode?, errorMessage? }`. Unknown routes answer `404 ROUTE_NOT_FOUND`.
`scripts/contract-test.mjs` records and compares status and JSON key shapes of every route (used around every deploy).

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
