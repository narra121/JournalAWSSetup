# Prod cut-over: API Gateway + 61 Lambdas → Lambda Web Function + Event Function

**Historical.** This was the one-time cut-over of `tradequt-prod`; it has been done (the prod stack now exports `ApiWebFunctionName`
`tradequt-prod-api`, and the API domain is served by CloudFront). Do not run steps 0 to 5 again. The parts that stay useful are
step 1 (backups), step 2 (the `--param` rules, also enforced on every later prod deploy), step 6 (rollback A, B and C) and step 7.
For normal prod deploys use [operations.md](operations.md) and `docs/ARCHITECTURE.md` section 9.

Stack `tradequt-prod` (account 675016865482, us-east-1). Owner approved the cut-over on 2026-11-11.

## What changes

| Before | After |
|---|---|
| HTTP API + 61 Lambda functions, API GW regional custom domain `api.tradequt.com` | 1 Lambda Web Function `tradequt-prod-api` (Hono, nodejs24.x) behind CloudFront (OAC) on the same domain |
| 4 event Lambdas | 1 Event Function `tradequt-prod-events` (Cognito triggers, Trades stream, schedules, e-mail jobs) |
| No PITR, no Retain on tables | PITR on all 11 tables, `Retain` on tables, user pool and buckets |
| Public extract Function URL | removed (extract is `POST /v1/trades/extract`, verified JWT + quota) |

Tables, user pool, client, buckets and the hosted zone are **never replaced**: `scripts/deploy.mjs` aborts if the change set
removes or replaces any of them. Expected removals are the 61 functions, their roles/permissions, the HTTP API, its stage,
domain and mapping, the Function URL and the old alarm. Expected adds are the Web Function set, CloudFront, the Event
Function, `AiData`, `Usage`, the alarms/SNS topic and the user-pool-id SSM parameter.
Expected DNS effect: `api.tradequt.com` A/AAAA flips to the CloudFront distribution; clients holding the old answer can
fail for 1–2 minutes (alias TTL 60 s).

## 0. Prerequisites (all must be true)

1. Dev has soaked 24 h with no alarm and `/aws/lambda/web/tradequt-dev-api` errors = 0.
2. The prod frontend no longer calls the dev extract URL: deploy TradeFlow `main` built without
   `VITE_EXTRACT_TRADES_URL`, then `rg "lambda-url" dist/assets` finds nothing. Only then remove `LegacyExtractFunction` from dev.
3. Stripe live objects exist (see `stripe-live.md`) and `/tradequt/prod/stripe/price/pro_*` + `portalConfigId` are in SSM.
4. Prod admin secrets exist at `/tradequt/prod/adminSecret` and `/tradequt/prod/adminJwtSecret`.
5. SES identity for the From domain exists; otherwise e-mails fail but nothing else is affected.
6. Tooling: `pip install "aws-sam-cli>=1.172.1" "cfn-lint>=1.60.0"`, bun 1.3.x, AWS profile `personal` (or CI keys).
7. The artifacts stack exists: `aws cloudformation describe-stacks --stack-name tradequt-artifacts` (created 2026-11-11).

## 1. Backups (automatic in step 4, can be run alone)

```
node scripts/backup.mjs --stage prod --out <R>\build\backups\prod-<yyyyMMdd_HHmmss>
```
Writes: one on-demand DynamoDB backup per table in the stack (11, waits for `AVAILABLE`), `stack.json`, `template-original.json`, `resources.json`,
`user-pool.json`, `user-pool-client.json`, `route53-records.json`, `REVERT.md`. Keep the folder until the soak ends.
The frontend and admin buckets are not changed by this stack update (no backup needed beyond the S3 versions they already keep).

## 2. Parameters (set with `--param`, same on the dry run and the real run)

Every prod run (dry run included) is given the parameters that differ from the stack's current values with a repeatable
`--param Key=Value`. The script **refuses to run** (exit code 4, no change set is created) unless, after applying them:

- `AlarmEmail` is a real e-mail address (otherwise the alarms have no subscriber), and
- `AdminSecretParamName` and `AdminJwtSecretParamName` are under `/tradequt/prod/` (the stack still points at the
  `/tradequt/adminSecret` and `/tradequt/adminJwtSecret` that dev shares), and
- `StripeSecretKeyParamName`, `StripeWebhookSecretParamName` and `AdConfigParamName` are under `/tradequt/prod/` (the template
  has no default for them; the existing prod stack already holds `/tradequt/prod/...`, so they carry over with no `--param`).

`--param` accepts only parameters the template declares, and not the ones the script computes (`CodeBucket`, `WebCodeKey`,
`WebCodeVersion`, `EventsCodeKey`, `EventsCodeVersion`). Every other parameter is carried over (`UsePreviousValue`).

```
PARAMS="--param AlarmEmail=<owner address> \
        --param AdminSecretParamName=/tradequt/prod/adminSecret \
        --param AdminJwtSecretParamName=/tradequt/prod/adminJwtSecret \
        --param AllowedOrigins=https://tradequt.com,https://www.tradequt.com,https://admin.tradequt.com \
        --param AppHost=tradequt.com --param LogRetentionDays=14"
```
Create the two prod secrets first (prerequisite 4). Confirm the SNS subscription mail once after the deploy.

Before it creates the change set the script prints the **final parameter table** (name, value, source = `explicit --param` /
`script` / `previous value` / `template default`; NoEcho values are masked). The owner reads that table before approving.

## 3. Dry run (no execution)

```
node scripts/deploy.mjs --stage prod --dry-run $PARAMS
```
Runs tests, `tsc`, `sam validate --lint`, builds both zips, uploads them with their S3 `VersionId`, checks the parameters
(above), creates a change set, applies the guard, prints the tally and deletes the change set. The owner reviews the
parameter table, the tally and `changeset.json` (saved next to the backups) against "What changes" above.

## 4. Execute (IST 02:00–05:00)

```
node scripts/deploy.mjs --stage prod --confirm-prod $PARAMS
```
Backups are taken first (step 1), then the change set from the dry run is created again with the same parameters and executed.
Order inside the single change set: CloudFront distribution with the alias is created (~5–10 min) → `ApiDnsRecord`
A-alias is upserted and the AAAA record added → the old API Gateway domain, mapping, API and 61 functions are deleted in
cleanup. The script waits for `UPDATE_COMPLETE` and polls `https://api.tradequt.com/v1/subscriptions/plans` until 200.
If CloudFormation rolls back, the previous state is restored automatically; empty Retain'd tables created by a failed
attempt (`AiData-*`, `Usage-*`) must be deleted before the retry after confirming they hold 0 items.

## 5. Verification

1. `node scripts/contract-test.mjs --record prod-after.json --api https://api.tradequt.com/v1` is **not** run against prod
   with a user (it logs in). Instead: unauthenticated probes of all routes must give the same status as before
   (`401` for Cognito routes, `403/401` for admin, `200/400` for public); `GET /v1/nope` → `404 ROUTE_NOT_FOUND`.
2. Forged token: `GET /v1/accounts` with a self-signed RS256 token → `401`.
3. CORS: `OPTIONS /v1/trades` with `Origin: https://tradequt.com` → `204` and the allow headers; `Origin: https://evil.example` → no CORS headers.
4. Owner signs in on tradequt.com: lists accounts and trades, creates and deletes a trade (delete shows Undo), opens
   Billing (checkout session opens, not paid), exports data.
5. `aws cloudformation describe-stacks --stack-name tradequt-prod` → `UPDATE_COMPLETE`; `aws lambda-web get-web-function-endpoint` active.
6. Alarms: `aws cloudwatch describe-alarms --alarm-name-prefix ""` for the six alarms with `ActionsEnabled=true`; publish a test message to `tradequt-prod-alarms`.
7. `describe-continuous-backups` on each table → `ENABLED`.

## 6. Rollback

- **A — bad app code (seconds):** point the endpoint at the previous revision.
  ```
  aws lambda-web update-web-function-endpoint --function-name tradequt-prod-api --endpoint-name live \
    --revision-weights '[{"revisionId":"<previous>","weight":100}]'
  aws lambda-web wait web-function-endpoint-updated --function-name tradequt-prod-api --endpoint-name live
  ```
  The previous revision is retained (`UpdateReplacePolicy: Retain`) and its zip version is never deleted.
- **B — infrastructure (~15 min):** check out commit `768ead7`, `sam build`, then deploy `infra/rollback/template-768ead7.yaml`
  (the old template plus PITR and Retain) with the parameters in the backup folder's `stack.json`. Table, pool and bucket names
  are unchanged and keep their data; DNS flips back to the recreated API Gateway domain; `AiData-*`/`Usage-*` stay as retained orphans.
  The template body exceeds 51,200 bytes: deploy with `--s3-bucket tradequt-artifacts-675016865482-us-east-1`.
- **C — data:** `aws dynamodb restore-table-to-point-in-time --source-table-name <t> --target-table-name <t>-restored --restore-date-time <ts>`
  (or `restore-table-from-backup` with an ARN from `dynamodb-backups.json`), verify, copy items back with a one-off script.
  Never swap stack tables by name.

## 7. After the cut-over

Delete nothing for 7 days. Then: remove the dev `LegacyExtractFunction` (set `ProdUserPoolId` empty on dev; it still exists on dev:
the `LegacyExtractFunctionUrl` output is present), delete the
backups older than 30 days, remove the Firebase and Razorpay repository secrets, and rotate the shared admin secrets.
