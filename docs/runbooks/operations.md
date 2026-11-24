# Operations

Stacks: `tradequt-dev`, `tradequt-prod` (backend), `tradequt-artifacts` (versioned code bucket). Region us-east-1,
profile `personal`. In this file `<StageName>` is `tradequt-dev` or `tradequt-prod` (the stack name and the template's `StageName` parameter). Prod is changed only with `node scripts/deploy.mjs --stage prod --confirm-prod` or the manual workflow
`.github/workflows/deploy-prod-manual.yml`. How the backend is built: [../ARCHITECTURE.md](../ARCHITECTURE.md).

## Everyday commands

| Task | Command |
|---|---|
| Run locally (same app as prod) | `bun run dev` → http://127.0.0.1:3001/v1/… (needs AWS credentials and the env vars of `.env.example`; see below) |
| Test, typecheck, lint | `bun run test`, `bunx tsc --noEmit`, `sam validate --lint` (run from a `C:/...` path, upper-case drive letter) |
| Build bundles | `bun run build` → `dist/web.zip`, `dist/events.zip` (deterministic: same input, same sha256) |
| Deploy dev | `node scripts/deploy.mjs --stage dev` (checks, build, upload, change set, guard, backup, execute, smoke) |
| Change set only | `node scripts/deploy.mjs --stage dev --dry-run` |
| Change a stack parameter | add `--param Key=Value` (repeatable); the final parameter table is printed before the change set |
| Contract check | `node scripts/contract-test.mjs --record before.json` then `--compare before.json` |
| Logs | `aws logs tail /aws/lambda/web/<StageName>-api --follow` (`bun run logs:dev`, `logs:prod`; the access log is one JSON line per request) |
| Event Function logs | `aws logs tail /aws/lambda/<StageName>-events --follow` |

Local env: `TRADES_TABLE`, `ACCOUNTS_TABLE`, `GOALS_TABLE`, `RULES_TABLE`, `DAILY_STATS_TABLE`, `USER_PREFERENCES_TABLE`,
`SAVED_OPTIONS_TABLE`, `SUBSCRIPTIONS_TABLE`, `AI_DATA_TABLE`, `USAGE_TABLE`, `RATE_LIMIT_TABLE`, `IMAGES_BUCKET`,
`ERROR_REPORTS_BUCKET`, `USER_POOL_ID`, `USER_POOL_CLIENT_ID`, `ALLOWED_ORIGINS`, `STAGE_NAME`, and the `*_PARAM` names.
The physical table names are `<Table>-<StageName>` (`Trades-<StageName>-v1` for trades), for example `Accounts-tradequt-dev`; the stack
outputs and `aws dynamodb list-tables` show them. The sample table names in `.env.example` (`Accounts-dev`, ...) do not match the deployed ones.

## Deploy safety

- Every deploy creates a change set first. `scripts/deploy.mjs` aborts (exit 2) when a DynamoDB table, Cognito user pool or
  client, S3 bucket or Route 53 hosted zone would be removed or replaced, and writes `changeset.json` to
  `<R>\build\backups\<stage>-<ts>\` (`<R>` = `TRADEQUT_RESEARCH`, default `C:\Users\narpra1\Work\Personal\TradeQut-Research`).
- Before executing it takes on-demand backups of all 11 tables and snapshots of the stack, template, user pool, client and
  DNS record, plus `REVERT.md` (`--skip-backup` turns this off). A prod deploy needs `--confirm-prod`.
- A web code change creates a new Web Function revision and moves the `live` endpoint to it; the previous revision is kept.

## Backup and restore

- Point-in-time recovery is on for every table (35 days). On-demand backups are taken by each deploy.
- Restore a table: `aws dynamodb restore-table-to-point-in-time --source-table-name <t> --target-table-name <t>-restored
  --restore-date-time <iso>`; verify the restored data; copy back with a script. Do not swap stack-managed table names.
- Deleted trades are soft-deleted for 30 days (`POST /v1/trades/restore`); DynamoDB TTL removes them afterwards.
- Account deletion (`DELETE /v1/auth/account`, admin delete) removes all tables' items, screenshots, error reports and the
  Cognito user, and cancels the Stripe subscription first. It is irreversible by design; restore only from a backup.

## Alarms (SNS topic `<StageName>-alarms`, optional `AlarmEmail` parameter)

| Alarm | Meaning | First check |
|---|---|---|
| `EventFunctionErrors-<StageName>` | Event Function errored in the last 5 min | its log group; stream records retry 2 times then go to `stats-dlq-<StageName>` |
| `StatsDlqVisible-<StageName>` | a stream batch failed permanently | read the DLQ message, fix, redrive or let the 6-hourly rebuild correct the stats |
| `ApiCloudFront5xx-<StageName>` | > 5 % 5xx for 5 min | web log group, then `aws lambda-web get-web-function-endpoint` state |
| `StripeWebhookFailed-<StageName>` | log line `stripe_webhook_failed` | Stripe dashboard → webhooks → failed deliveries are retried automatically; fix and resend |
| `GeminiErrors-<StageName>` | ≥ 5 log lines containing `gemini_error` in 5 min | No file in `src/` writes `gemini_error` (AI failures log `ai_unavailable`), so this alarm cannot fire today. For AI failures search the web log group for `ai_unavailable`; check the provider status, quota and the key in SSM |
| `AdminLoginFailed-<StageName>` | ≥ 10 `Admin login failed: wrong password` or `Admin login blocked: global attempt limit reached` in 5 min | web log group for the source IPs (`admin-login:<ip>` rows in the RateLimit table); the global bucket `admin-login:global` (50/hour) locks the real admin out for the rest of the hour while it is hit |

## Incidents

- **Everything returns 5xx after a deploy:** rollback A in [prod-cutover.md](prod-cutover.md) (re-weight the endpoint to the previous revision, same commands for dev), then investigate.
- **Stripe webhook failing:** check that the SSM parameter `/tradequt/<stage>/stripeWebhookSecret` (template parameter `StripeWebhookSecretParamName`, read through `STRIPE_WEBHOOK_SECRET_PARAM`) equals the endpoint's signing secret;
  Stripe resends for 3 days. Events are ordered by Stripe's event time, so late
  retries cannot overwrite newer state.
- **A user is charged but still Free:** `GET /v1/subscriptions/verify?session_id=…` re-applies the latest session; otherwise
  resend the webhook event from Stripe.
- **Stats look wrong:** invoke the rebuild: `aws lambda invoke --function-name tradequt-<stage>-events
  --cli-binary-format raw-in-base64-out --payload '{"job":"rebuild-stats"}' out.json` (it rebuilds users with recent changes).
  That job only rebuilds users flagged dirty and skips every day whose trade hash (tradeId | pnl | updatedAt) is unchanged,
  so after a change to how a daily record is computed (for example realised R from prices) every user needs a forced
  rebuild, `rebuildForUser(userId, { force: true })` from `src/handlers/rebuild-stats-job/app.ts`. Back up first
  (`node scripts/backup.mjs --stage <stage> --out backups/<stage>`), then from the repo root with `AWS_PROFILE`, `AWS_REGION`, `TRADES_TABLE`, `ACCOUNTS_TABLE`,
  `DAILY_STATS_TABLE` and `USER_PREFERENCES_TABLE` set for the stage:
  ```
  bun -e "import { DynamoDBClient } from '@aws-sdk/client-dynamodb'; import { DynamoDBDocumentClient, ScanCommand } from '@aws-sdk/lib-dynamodb'; import { rebuildForUser } from './src/handlers/rebuild-stats-job/app.ts'; const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({})); const users = new Set(); let key; do { const r = await ddb.send(new ScanCommand({ TableName: process.env.ACCOUNTS_TABLE, ProjectionExpression: 'userId', ExclusiveStartKey: key })); for (const it of r.Items ?? []) users.add(it.userId); key = r.LastEvaluatedKey; } while (key); for (const u of users) { await rebuildForUser(u, { force: true }); console.log('rebuilt', u); } console.log('done', users.size);"
  ```
  Check: `GET /v1/stats?accountId=ALL&startDate=…&endDate=…` returns a numeric `avgR` and `rCount` > 0 for a user whose trades have stops.
- **E-mails not arriving:** the From domain (`AppDomain` parameter) must be a verified SES identity (the account has SES production access); failures are logged as
  `lifecycle_email_failed` / `payment_failed_email_error`.
- **Abuse or traffic spike:** the endpoint caps requests (`ThrottleConfig` `RateLimit` 100/s dev, 300/s prod) and environments (`MaxEnvironments`); raise in
  `ApiEndpoint` in the template. Each signed-in user is also held to 600 requests per 60 s (`user:<sub>` items in the RateLimit table, answer
  429 `RATE_LIMITED`; `src/app/http/rate-limit.ts`), so one account cannot use the whole endpoint budget. A CloudFront WAF rate-based rule is the next step when abuse is seen; `template.yaml` has no web ACL today.

## Secrets and keys

| Name | Where | Rotation |
|---|---|---|
| `/tradequt/<env>/stripeSecretKey`, `/tradequt/<env>/stripeWebhookSecret` | SSM SecureString | roll in Stripe, `put-parameter --overwrite`; caches refresh within 15 min (restart not needed) |
| `/tradequt/openrouterApiKey` (default AI provider), `/tradequt/geminiApiKey` (used when `AiProvider` is `gemini`) | SSM SecureString | same; the AI key cache is 1 hour |
| `/tradequt/adminSecret`, `/tradequt/adminJwtSecret` (dev defaults); `/tradequt/prod/adminSecret`, `/tradequt/prod/adminJwtSecret` (prod, required by `scripts/deploy.mjs`) | SSM SecureString | changing the JWT secret signs every admin out; cache 15 min |
| GitHub repository secrets | `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` (used by `deploy.yml` and `deploy-prod-manual.yml`) | rotate in IAM |

## Cost drivers

Route 53 hosted zones, CloudFront, DynamoDB on-demand with point-in-time recovery, CloudWatch logs (`LogRetentionDays`), Web
Function compute while an environment exists, and AI provider calls (limited per user per month by the quotas in
`src/app/billing/entitlements.ts`). Web Function scaling: `MaxConcurrencyPerEnvironment` and `MaxEnvironments` in
`ApiRevision` / `ApiEndpoint` of `template.yaml`.
