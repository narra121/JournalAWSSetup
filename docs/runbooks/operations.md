# Operations

Stacks: `tradequt-dev`, `tradequt-prod` (backend), `tradequt-artifacts` (versioned code bucket). Region us-east-1,
profile `personal`. Prod is changed only through `docs/runbooks/prod-cutover.md` / the manual workflow.

## Everyday commands

| Task | Command |
|---|---|
| Run locally (same app as prod) | `bun run dev` → http://127.0.0.1:3001/v1/… (needs AWS credentials and the table/bucket env vars; see below) |
| Test, typecheck, lint | `bun run test`, `bunx tsc --noEmit`, `sam validate --lint` |
| Build bundles | `bun run build` → `dist/web.zip`, `dist/events.zip` (deterministic: same input, same sha256) |
| Deploy dev | `node scripts/deploy.mjs --stage dev` (checks, build, upload, change set, guard, backup, execute, smoke) |
| Change set only | `node scripts/deploy.mjs --stage dev --dry-run` |
| Change a stack parameter | add `--param Key=Value` (repeatable); the final parameter table is printed before the change set |
| Contract check | `node scripts/contract-test.mjs --record before.json` then `--compare before.json` |
| Logs | `aws logs tail /aws/lambda/web/tradequt-<stage>-api --follow` (access log is one JSON line per request) |
| Event Function logs | `aws logs tail /aws/lambda/tradequt-<stage>-events --follow` |

Local env: `TRADES_TABLE`, `ACCOUNTS_TABLE`, `GOALS_TABLE`, `RULES_TABLE`, `DAILY_STATS_TABLE`, `USER_PREFERENCES_TABLE`,
`SAVED_OPTIONS_TABLE`, `SUBSCRIPTIONS_TABLE`, `AI_DATA_TABLE`, `USAGE_TABLE`, `RATE_LIMIT_TABLE`, `IMAGES_BUCKET`,
`ERROR_REPORTS_BUCKET`, `USER_POOL_ID`, `USER_POOL_CLIENT_ID`, `ALLOWED_ORIGINS`, `STAGE_NAME`, and the `*_PARAM` names.
The stack outputs and `aws cloudformation describe-stack-resources` list the physical names.

## Deploy safety

- Every deploy creates a change set first. `scripts/deploy.mjs` aborts (exit 2) when a DynamoDB table, Cognito user pool or
  client, S3 bucket or Route 53 hosted zone would be removed or replaced, and writes `changeset.json` to
  `<R>\build\backups\<stage>-<ts>\`.
- Before executing it takes on-demand backups of all 11 tables and snapshots of the stack, template, user pool, client and
  DNS record, plus `REVERT.md`. A prod deploy needs `--confirm-prod`.
- A web code change creates a new Web Function revision and moves the `live` endpoint to it; the previous revision is kept.

## Backup and restore

- Point-in-time recovery is on for every table (35 days). On-demand backups are taken by each deploy.
- Restore a table: `aws dynamodb restore-table-to-point-in-time --source-table-name <t> --target-table-name <t>-restored
  --restore-date-time <iso>`; verify the restored data; copy back with a script. Do not swap stack-managed table names.
- Deleted trades are soft-deleted for 30 days (`POST /v1/trades/restore`); DynamoDB TTL removes them afterwards.
- Account deletion (`DELETE /v1/auth/account`, admin delete) removes all tables' items, screenshots, error reports and the
  Cognito user, and cancels the Stripe subscription first. It is irreversible by design; restore only from a backup.

## Alarms (SNS topic `tradequt-<stage>-alarms`, optional `AlarmEmail` parameter)

| Alarm | Meaning | First check |
|---|---|---|
| `EventFunctionErrors-<stage>` | Event Function errored in the last 5 min | its log group; stream records retry 2 times then go to `stats-dlq-<stage>` |
| `StatsDlqVisible-<stage>` | a stream batch failed permanently | read the DLQ message, fix, redrive or let the 6-hourly rebuild correct the stats |
| `ApiCloudFront5xx-<stage>` | > 5 % 5xx for 5 min | web log group, then `aws lambda-web get-web-function-endpoint` state |
| `StripeWebhookFailed-<stage>` | log line `stripe_webhook_failed` | Stripe dashboard → webhooks → failed deliveries are retried automatically; fix and resend |
| `GeminiErrors-<stage>` | ≥ 5 `gemini_error` in 5 min | Gemini status, quota, key in SSM |

## Incidents

- **Everything returns 5xx after a deploy:** rollback A in the cut-over runbook (re-weight the endpoint), then investigate.
- **Stripe webhook failing:** check `STRIPE_WEBHOOK_SECRET` in SSM equals the endpoint's signing secret
  (`/tradequt/<env>/stripeWebhookSecret`); Stripe resends for 3 days. Events are ordered by Stripe's event time, so late
  retries cannot overwrite newer state.
- **A user is charged but still Free:** `GET /v1/subscriptions/verify?session_id=…` re-applies the latest session; otherwise
  resend the webhook event from Stripe.
- **Stats look wrong:** invoke the rebuild: `aws lambda invoke --function-name tradequt-<stage>-events
  --cli-binary-format raw-in-base64-out --payload '{"job":"rebuild-stats"}' out.json` (it rebuilds users with recent changes).
- **E-mails not arriving:** SES sandbox / unverified identity (ACCESS-NEEDED #10); failures are logged as
  `lifecycle_email_failed` / `payment_failed_email_error`.
- **Abuse or traffic spike:** the endpoint caps requests (`RateLimit` 100/s dev, 300/s prod) and environments (2 / 10); raise in
  the template. A CloudFront WAF rate-based rule (2,000 requests / 5 min / IP, about $6/month) is the next step when abuse is
  seen; it is deliberately not enabled today.

## Secrets and keys

| Name | Where | Rotation |
|---|---|---|
| `/tradequt/<env>/stripeSecretKey`, `/tradequt/<env>/stripeWebhookSecret` | SSM SecureString | roll in Stripe, `put-parameter --overwrite`; caches refresh within 15 min (restart not needed) |
| `/tradequt/geminiApiKey` | SSM SecureString | same |
| `/tradequt/<env>/adminSecret`, `/tradequt/<env>/adminJwtSecret` (prod: ACCESS-NEEDED #11) | SSM SecureString | changing the JWT secret signs every admin out |
| GitHub secrets | `AWS_ACCESS_KEY_ID/SECRET` (static keys today; OIDC role is owner item B-095), `GOOGLE_*` | rotate in IAM |

## Cost model (dev + prod, current traffic)

Account ≈ $1–5/month: Route 53 hosted zones, CloudFront free tier (1 TB, 10 M requests), DynamoDB on-demand with PITR
(cents), CloudWatch logs with 7/14-day retention, Web Function compute while an environment exists (one 2 GB environment
alive all month ≈ $3), Gemini per call (limited per user per month by quotas). Set an AWS Budget of $10/month (ACCESS-NEEDED).
Web Function scaling: ≤ 64 concurrent requests per environment, up to 2 (dev) / 10 (prod) environments.
